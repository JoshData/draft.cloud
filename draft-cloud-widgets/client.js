/* This module manages an open connection between the client and
   the Draft.cloud server for a single document. */

var jot = require("../jot");

exports.pull_interval = 400;
exports.push_interval = 400;

exports.Client = function(owner_name, document_name, api_key, channel, widget, logger) {
  // Our state.
  var closed = false;

  // Document state.
  var base_revision;

  // Channel state.
  var channel_push_func;
  var channel_close_func;
  var remote_changes = [];
  var pushing = false;
  var last_push_patch = null;
  var last_push_revision = null;

  if (logger)
    logger("opening document using " + channel.name);

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
      base_revision = doc.revision;
      channel_push_func = doc.pushfunc;
      channel_close_func = doc.closefunc;

      // Let the caller know the initial content and that
      // the document is open.
      if (logger)
        logger(owner_name + "/" + document_name, "document opened with " + doc.access_level + " access");
      var readonly = !(doc.access_level == "WRITE" || doc.access_level == "ADMIN");
      widget.initialize({
        content: doc.content,
        revision: base_revision,
        readonly: readonly
      });

      // Begin periodically pulling new remote changes and pushing
      // new local changes.
      pull_remote_changes();
      if (!readonly)
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
    // We've received a list of new Revisions from the server that ocurred since
    // base_revision. These revisions may come from one of three segments of
    // time/state:
    //
    // * Before last_push_revision. They diverged from what we've sent at base_revision.
    //   In order to update the widget, we must rebase these changes against our last
    //   push. (We let the server handle merges when we push, so we are not aware of
    //   concurrent remote changes at the time we push. This is the paired rebase
    //   with the rebase that happens on the server to merge concurrent edits.)
    //
    // * The Revision might be last_push_revision itself, which is how we'll
    //   know that we've caught up to what we submitted. (We don't push any local
    //   changes while local changes are in flight and we're waiting to see
    //   last_push_revision come back.)
    //
    // * After last_push_revision (if last_push_revision is set). This will only occur
    //   if this is the first time we're receiving new remote changes after seeing
    //   our last change come back. So what we do here to them is parallel to what we
    //   do to revisions that come in on the next iteration --- i.e. last_push_revision
    //   is no longer set and no rebase is necessary.

    var history_before_push = [];
    var our_revision = null;
    var history_after_push = [];
    history.forEach(function(revision) {
      // Deserialize.
      revision.op = jot.opFromJSON(revision.op);

      // Split the revisions.
      if (!revision.id) throw ["invalid revision id", revision];
      if (revision.id == last_push_revision)
        our_revision = revision.op;
      else if (our_revision === null)
        history_before_push.push(revision.op);
      else
        history_after_push.push(revision.op);

      // Remember the most recent ID for updating state at the end.
      last_revision_id = revision.id;
    });

    // Turn the history arrays into jot operations.
    history_before_push = new jot.LIST(history_before_push).simplify();
    history_after_push = new jot.LIST(history_after_push).simplify();

    // Before we pass the remote history to the widget, we have to bring it
    // up to speed with the changes the widget has already told us about.
    // They requires rebasing history_before_push on the local changes we
    // last submitted. Then we shimmy the last_push_patch forward as if
    // acknowledging that we've received those changes, in case we receive
    // more Revisions before our push in a later call. history_after_push
    // does not need to be rebased because it follows our push.
    var widget_patch = history_before_push;
    if (last_push_patch) {
      // Rebase history_before_push.
      widget_patch = history_before_push.rebase(last_push_patch, true);
      last_push_patch = last_push_patch.rebase(history_before_push, true);

      // Compose with history_2. (nb. compose() may return null if an atomic
      // compose is not possible, so we use a LIST to ensure we get a valid
      // composition object.)
      widget_patch = widget_patch.compose(history_after_push).simplify();
    }

    // Send the history to the widget.
    if (!widget_patch.isNoOp()) {
      if (logger)
        logger(owner_name + "/" + document_name, "received " + widget_patch.inspect());
      widget.merge_remote_changes(widget_patch);
    }

    // Update Document State
    // =====================
    // Apply the total history we saw to the 
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
    // only have the base_revision as a peg. Also don't push
    // if we don't have a channel to push to.
    if (!pushing && !last_push_revision && channel_push_func) {
      // Push the local changes --- everything queued up as
      // a single revision.
      var patch = widget.pop_changes();
      if (!patch.isNoOp()) {
        pushing = true;
        if (logger)
          logger(owner_name + "/" + document_name, "sent " + patch.inspect());
        widget.status("saving");
        channel_push_func(base_revision, patch, function(err, revision) {
          // Remember the revision information of the last push.
          pushing = false;
          if (revision) {
            last_push_revision = revision.id;
            last_push_patch = patch;

            // Let the widget know we are in a saved state now, if there are
            // no new local changes.
            widget.status("saved");
          }
          if (err) {
            // TODO: Restore state to try again later.
            widget.nonfatal_error(err);
          }
        })
      }
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
        

