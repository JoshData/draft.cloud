/* This module manages an open connection between the client and
   the Draft.cloud server for a single document. */

var jot = require("../jot");

exports.pull_interval = 400;
exports.push_interval = 400;

exports.Client = function(owner_name, document_name, api_key, channel, widget, logger) {
  // Our state.
  var closed = false;

  // Document state.
  var base_content;
  var base_revision;

  // Channel state.
  var channel_push_func;
  var channel_close_func;
  var remote_changes = [];
  var pushing = false;
  var last_push_patch = null;
  var last_push_revision = null;

  // Widget state.
  var local_changes = [];

  function log(a1, a2, a3, a4) {
    console.debug("Draft.cloud", { owner: owner_name, document: document_name }, a1, a2, a3, a4);
  }

  log("opening document using", channel.name);

  widget.status("Loading...");

  // Open the channel and start receiving remote changes.
  channel.open(owner_name, document_name, api_key, {
    error: function(msg) {
      // Fatal error opening initial connction.
      alert(msg);
    },
    opened: function(doc) {
      // The document was successfully opened. We've now got
      // its current content and the corresponding revision id.
      if (closed) { doc.closefunc(); return; } // closed before calledback
      base_content = doc.content;
      base_revision = doc.revision;
      channel_push_func = doc.pushfunc;
      channel_close_func = doc.closefunc;

      // Let the caller know the initial content and that
      // the document is open.
      log("document opened at", base_revision, doc.access_level);
      if (logger)
        logger(owner_name + "/" + document_name, "document opened with " + doc.access_level + " access");
      widget.initialize({
        content: base_content,
        revision: base_revision,
        readonly: !(doc.access_level == "WRITE" || doc.access_level == "ADMIN")
      },
      function(patch) {
        local_changes.push(patch);
      });

      // Once the widget is initialized, there is no status.
      widget.status();

      // Begin periodically pulling new remote changes and pushing
      // new local changes.
      pull_remote_changes();
      push_local_changes();
    },
    pull: function(revisions) {
      // New changes have come in from the server. Append them
      // to the end of remote_changes. We'll process them
      // asynchronously.
      revisions.forEach(function(rev) { remote_changes.push(rev); })
    },
    nonfatal_error: function(message) {
      if (closed) return;
      widget.nonfatal_error(message);
    }
  });

  // Run an async method to process incoming remote changes.
  function pull_remote_changes() {
    // Stop and don't schedule more polling if we're closed.
    if (closed) return;

    // Are there remote changes to process?
    if (remote_changes.length > 0) {
      // Don't process remote changes if we're in the middle of
      // pushing local changes because then we might get the
      // local change back before we know its revision id.
      if (!pushing) {
        // Process the queued-up remote changes and then clear
        // the queue.
        merge_remote_changes(remote_changes);
        remote_changes = [];
      }
    }
    
    setTimeout(pull_remote_changes, exports.pull_interval);
  }

  function merge_remote_changes(history) {
    log("document changed remotely", owner_name, document_name, history);

    // Update the widget
    // =================
    //
    // The widget may have local changes that have not even been submitted
    // to the server yet. The incoming changes must be rebased against
    // anything done in the widget.
    //
    // Divide the history into two segments:
    // 1) Changes made after our last pull but before our last push.
    //    These changes diverged at base_content/base_revision, so
    //    we'll rebase them on the difference between that point and
    //    the current local state of the document.
    // 2) Changes made after our last push. These changes diverged at
    //    the point of our last push, so we'll rebase them against the
    //    difference between what we last pushed and the current local
    //    state of the document.
    // We need to divide the history because we should not apply our
    // own revision a second time -- we need to take our own revision
    // out of the history.
    var history_1 = [];
    var our_revision = null;
    var history_2 = [];
    history.forEach(function(revision) {
      // Deserialize.
      revision.op = jot.opFromJSON(revision.op);

      // Split the revisions.
      if (revision.id == last_push_revision)
        our_revision = revision.op;
      else if (our_revision === null)
        history_1.push(revision.op);
      else
        history_2.push(revision.op);

      // Remember the most recent ID.
      last_revision_id = revision.id;
    });

    // Turn the history arrays into jot operations.
    history_1 = new jot.LIST(history_1).simplify();
    history_2 = new jot.LIST(history_2).simplify();

    // history_1 diverged from our current state at base_content/base_revision.
    // Rebase against everything that has happened locally since then, and then
    // apply it.
    var current_content = widget.get_document();
    var history_1_rebased = new jot.NO_OP();
    if (!history_1.isNoOp()) {
      var local_changes_1 = jot.diff(base_content, current_content);
      history_1_rebased = history_1.rebase(local_changes_1, true);
      if (history_1_rebased === null) {
        alert("There was an unresolvable conflict (1).");
        return;
      }
    }

    // history_2 diverged from our current state as of last_push_content/last_push_revision.
    // Rebase against everything that has happened since our last push.
    var history_2_rebased = new jot.NO_OP();
    if (!history_2.isNoOp()) {
      var last_push_content = last_push_patch.apply(base_content);
      var local_changes_2 = jot.diff(last_push_content, current_content);
      history_2_rebased = history_2.rebase(local_changes_2, true);
      if (history_2_rebased === null) {
        alert("There was an unresolvable conflict (2).");
        return;
      }
    }

    // Apply the rebased histories, without our revision, to the current
    // document content.
    var widget_patch = new jot.LIST([history_1_rebased, history_2_rebased]).simplify();
    if (!widget_patch.isNoOp()) {
      if (logger)
        logger(owner_name + "/" + document_name, "received " + widget_patch.inspect());
      widget.update_document(widget_patch);
    }

    // Update Pending Local Changes
    // ============================
    // If there are local changes queued up, those changes must be rebased because we
    // are about to change the state that determines what their base revision is.
    //
    // A) If !last_push_revision, then the changes are queued up against
    //    base_revision and must be rebased against history_1. our_revision and history_2
    //    will be empty.
    //
    // If pushing is true, then we have some changes in flight, but this function
    // won't be called in that case. It'll be called after the push is done and
    // last_push_revision is set.
    //
    // B) If last_push_revision is set, then the local changes acumulated after
    //    we last sent changes to the server, which corresponds with last_push_revision.
    //    The changes must be rebased against history_2.
    if (local_changes.length > 0) {
      local_changes = [
        new jot.LIST(local_changes).simplify()
          .rebase(
            (!last_push_revision)
              ? history_1
              : history_2
          )
      ];
    }

    // Update Document State
    // =====================
    // Use the actual history we received from the server,
    // without rebases.
    base_content = new jot.LIST([history_1, our_revision ? our_revision : new jot.NO_OP(), history_2])
      .apply(base_content);
    base_revision = last_revision_id;
    last_push_patch = null;
    last_push_revision = null;
  }

  // Run an async method to process outgoing local changes.
  function push_local_changes() {
    // Stop and don't schedule more polling if we're closed.
    if (closed) return;

    // Don't push while another push is in progress or while
    // we're waiting to see our own revision come back as a
    // remote change because the document has changed and we
    // only have the base_revision as a peg.
    if (!pushing && !last_push_revision && local_changes.length > 0
      && channel_push_func) {
      // Push the local changes --- everything queued up as
      // a single revision.
      pushing = true;
      var patch = new jot.LIST(local_changes).simplify();
      log("pushing local changes", patch);
      if (logger)
        logger(owner_name + "/" + document_name, "sent " + patch.inspect());
      widget.status("Saving...");
      channel_push_func(base_revision, patch, function(err, revision) {
        // Remember the revision information of the last push.
        pushing = false;
        if (revision) {
          log("got local changes revision", revision);
          last_push_revision = revision.id;
          last_push_patch = patch;

          // Let the widget know we are in a saved state now, if there are
          // no new local changes.
          if (local_changes.length == 0)
            widget.status("Saved.");
        }
        if (err) {
          // TODO: Restore state to try again later.
          widget.nonfatal_error(err);
        }
      })

      // Clear the queue of local changes.
      local_changes = [];
    
    } else if (local_changes.length > 0) {
      // If there are unsaved changes that we can't push right now, warn
      // the user.
      widget.status("Not Saved");
    }
    
    // Push again soon.
    setTimeout(push_local_changes, exports.push_interval);
  }

  return {
    close: function() {
      // Function to shut down the channel and all polling.
      if (!closed)
        if (logger)
          logger(owner_name + "/" + document_name, "closed");
      closed = true;
      if (channel_close_func)
        channel_close_func();
    } 
  }
};
        

