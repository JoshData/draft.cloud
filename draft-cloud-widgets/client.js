/* This module manages an open connection between the client and
   the Draft.cloud server for a single document. */

var jot = require("../jot");

exports.push_interval = 200;

exports.Client = function(owner_name, document_name, api_key, channel, widget, logger) {
  // Our state.
  var closed = false;
  var pushIntervalObj = null;

  // Document state.
  var widget_base_content;
  var widget_base_revision;

  // Channel state.
  var channel_methods;
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
    opened: function(user, doc, methods) {
      // The document was successfully opened. We've now got
      // its current content and the corresponding revision id.
      if (closed) { doc.closefunc(); return; } // closed before calledback

      logger("document opened by " + user.name + " with " + doc.access_level + " access");

      // Set global state.
      widget_base_content = doc.content;
      widget_base_revision = doc.revision;
      channel_methods = methods;

      // Do we have write access?
      var readonly = !(doc.access_level == "WRITE" || doc.access_level == "ADMIN");

      // Initialize the widget.
      widget.initialize({
        user: user,
        content: doc.content,
        readonly: readonly,
        logger: logger
      });

      // Begin periodically pushing new local changes.
      if (!readonly)
        pushIntervalObj = setInterval(push_local_changes, exports.push_interval);
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
      logger("remote changes queued during revision push");
      return;
    }

    // We expect to receive:
    //
    // A) Revisions submitted by other clients to the server
    //    after we sent one but before the server committed
    //    ours, if we have one in flight.
    //
    // B) Our own Revision, if we have one in flight.
    //
    // C) Revisions submitted by other clients while we have
    //    nothing in flight, or after our in flight Revision
    //    was committed.
    //
    // Split the incoming Revisions into two arrays for (A)
    // and (C).

    var last_revision_id;
    var revs_before_ours = [];
    var seen_ours = false;
    var revs_after_ours = [];
    remote_changes.forEach(function(revision) {
      if (waiting_for_local_change_to_return
          && revision.id == waiting_for_local_change_to_return.revision_id)
        seen_ours = true;
      else if (!seen_ours && waiting_for_local_change_to_return)
        revs_before_ours.push(jot.opFromJSON(revision.op));
      else
        revs_after_ours.push(jot.opFromJSON(revision.op));

      // Remember the most recent ID for updating state at the end.
      last_revision_id = revision.id;
    });

    // If we have a change in flight but don't see it yet, keep waiting.
    if (waiting_for_local_change_to_return && !seen_ours) {
      logger("remote changes queued waiting for our revision to commit");
      return;
    }

    logger("received "
      + (!waiting_for_local_change_to_return
        ? ""
        : (revs_before_ours.length + "+" ))
      + revs_after_ours.length
      + " revisions");

    // Turn the history arrays into jot operations.
    revs_before_ours = new jot.LIST(revs_before_ours).simplify();
    revs_after_ours = new jot.LIST(revs_after_ours).simplify();

    if (waiting_for_local_change_to_return) {
      // Since revs_before_ours diverged from the history at the
      // same point as our last push, we need to rebase it against
      // what we sent to the server.
      revs_before_ours = revs_before_ours.rebase(
        waiting_for_local_change_to_return.op, 
        { document: widget_base_content }
      )

      // Advance the base content.
      widget_base_content = waiting_for_local_change_to_return.op.apply(widget_base_content);
      widget_base_content = revs_before_ours.apply(widget_base_content);
    }

    // Compose that with revs_after_ours, which occurred after
    // our last push so no rebase is necessary. Advance the base content.
    var patch = revs_before_ours.compose(revs_after_ours).simplify();
    widget_base_content = revs_after_ours.apply(widget_base_content);

    // Send the history to the widget.
    if (!patch.isNoOp())
      widget.merge_remote_changes(patch);

    // Update Document State
    // =====================
    remote_changes = [];
    widget_base_revision = last_revision_id;
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
      && channel_methods) {
      // Push the local changes --- everything queued up as
      // a single revision.
      var patch = widget.pop_changes();
      if (!patch.isNoOp()) {
        waiting_for_local_change_to_save = true;

        logger("sent " + patch.inspect());
        
        widget.status("saving");

        channel_methods.push(widget_base_revision, patch, function(err, revision) {
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
  }

  return {
    close: function() {
      // Function to shut down the channel and all polling.
      widget.destroy();
      if (!closed)
        logger("connection closed");
      closed = true;
      if (channel_methods)
        channel_methods.close();
      if (pushIntervalObj)
        clearInterval(pushIntervalObj);
    } 
  }
};
        

