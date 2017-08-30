/* This module manages an open connection between the client and
   the Draft.cloud server for a single document. */

var jot = require("../jot");

exports.push_interval = 200;

exports.Client = function(owner_name, document_name, api_key, channel, widget, logger) {
  // Our state.
  var closed = false;

  // Document state.
  var widget_base_revision;

  // Channel state.
  var channel_push_func;
  var channel_close_func;
  var remote_changes = [];
  var waiting_for_local_change_to_save = false;
  var waiting_for_local_change_to_return = null;

  if (logger) {
    // rewrite so future calls can skip the first argument
    var old_logger = logger;
    logger = function(msg) { old_logger(owner_name+"/"+document_name, msg); }
  } else {
    // add a dummy function
    logger = function(msg) { }
  }

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

      logger("document opened with " + doc.access_level + " access");

      // Set global state.
      widget_base_revision = doc.revision;
      channel_push_func = doc.pushfunc;
      channel_close_func = doc.closefunc;

      // Do we have write access?
      var readonly = !(doc.access_level == "WRITE" || doc.access_level == "ADMIN");

      // Initialize the widget.
      widget.initialize({
        content: doc.content,
        readonly: readonly,
        logger: logger
      });

      // Begin periodically pushing new local changes.
      if (!readonly)
        push_local_changes();
    },
    pull: function(revisions) {
      // New changes have come in from the server. Append them
      // to the end of remote_changes and then try to process
      // them.
      revisions.forEach(function(rev) { remote_changes.push(rev); })
      merge_remote_changes();
    },
    nonfatal_error: function(message) {
      if (closed) return;
      widget.nonfatal_error(message);
    }
  });

  function merge_remote_changes() {
    // Process any Revisions the server sent to us.

    // Are there remote changes to process?
    if (remote_changes.length == 0)
      return;

    // Don't process remote changes after local changes have
    // been submitted but before we've gotten back the revision
    // ID otherwise we might get back the local change as a
    // revision before we know its ID.
    if (waiting_for_local_change_to_save) {
      logger("remote changes queued");
      return;
    }

    // We've got a list of new Revisions from the server that ocurred since
    // widget_base_revision. These revisions may come from one of three segments of
    // time/state:
    //
    // * Before the last local change. They diverged from what we've sent at widget_base_revision.
    //   In order to update the widget, we must rebase these changes against our last
    //   push. (We let the server handle merges when we push, so we are not aware of
    //   concurrent remote changes at the time we push. This is the paired rebase
    //   with the rebase that happens on the server to merge concurrent edits.)
    //
    // * The Revision might be the last local change itself, which is how we'll
    //   know that we've caught up to what we submitted. (We don't push any local
    //   changes while local changes are in flight and we're waiting to see
    //   it come back as a committed Revision.)
    //
    // * After our last local change. This will only occur
    //   if this is the first time we're receiving new remote changes after seeing
    //   our last change come back.

    var history_before_push = [];
    var seen_our_revision = false;
    var history_after_push = [];
    remote_changes.forEach(function(revision) {
      // Deserialize.
      revision.op = jot.opFromJSON(revision.op);

      // Split the revisions.
      if (waiting_for_local_change_to_return
          && revision.id == waiting_for_local_change_to_return.revision_id)
        seen_our_revision = true;
      else if (!seen_our_revision && waiting_for_local_change_to_return)
        history_before_push.push(revision.op);
      else
        history_after_push.push(revision.op);

      // Remember the most recent ID for updating state at the end.
      last_revision_id = revision.id;
    });

    logger("received revisions "
      + (!waiting_for_local_change_to_return
        ? ""
        : (history_before_push.length
           + "/" + seen_our_revision
           + "/"))
      + history_after_push.length);

    // Turn the history arrays into jot operations.
    history_before_push = new jot.LIST(history_before_push).simplify();
    history_after_push = new jot.LIST(history_after_push).simplify();

    if (waiting_for_local_change_to_return) {
      // Since history_before_push diverged from the history at the
      // same point as our last push, we need to rebase it against
      // what we sent to the server.
      history_before_push = history_before_push.rebase(
        waiting_for_local_change_to_return.op, 
        true//TODO
      )
    }

    // Compose that with history_after_push, which occurred after
    // our last push so no rebase is necessary.
    var widget_patch = history_before_push.compose(history_after_push).simplify();

    // Send the history to the widget.
    if (!widget_patch.isNoOp()) {
      widget.merge_remote_changes(widget_patch);
    }

    // Update Document State
    // =====================
    remote_changes = [];
    widget_base_revision = last_revision_id;
    if (seen_our_revision)
      waiting_for_local_change_to_return = null;
  }

  // Run an async method to process outgoing local changes.
  function push_local_changes() {
    // Stop and don't schedule more polling if we're closed.
    if (closed) return;

    // Don't push while we're waiting to see our own revision come
    // back as a remote change or else we'll get confused.
    // Also don't push if we don't have a channel to push to.
    if (
         !waiting_for_local_change_to_save
      && !waiting_for_local_change_to_return
      && channel_push_func) {
      // Push the local changes --- everything queued up as
      // a single revision.
      var patch = widget.pop_changes();
      if (!patch.isNoOp()) {
        waiting_for_local_change_to_save = true;

        logger("sent " + patch.inspect());
        
        widget.status("saving");

        channel_push_func(widget_base_revision, patch, function(err, revision) {
          // We've gotten back the revision ID for the patch we
          // submitted. Remember it for later when we process
          // remote changes, so we can identify when we see
          // our own change come back to us as a remote change.
          if (revision) {
            waiting_for_local_change_to_return = {
              revision_id: revision.id,
              op: patch
            }

            // Let the widget know we are in a saved state now, if there are
            // no new local changes.
            widget.status("saved");
          }
          if (err) {
            // TODO: Restore state to try again later.
            widget.nonfatal_error(err);
          }

          // Clear the flag that we've got a change in the channel,
          // and since the pushing state has changed we can now
          // process remote changes if there are any.
          waiting_for_local_change_to_save = false;
          merge_remote_changes();
        })
      }
    }
    
    // Push again soon.
    setTimeout(push_local_changes, exports.push_interval);
  }

  return {
    close: function() {
      // Function to shut down the channel and all polling.
      widget.destroy();
      if (!closed)
        logger("connection closed");
      closed = true;
      if (channel_close_func)
        channel_close_func();
    } 
  }
};
        

