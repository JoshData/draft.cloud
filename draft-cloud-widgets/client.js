/* The Client class defined in this module manages the connection
   between the Draft.Cloud server and a UI widget for a single
   document.

   Communication with the Draft.Cloud server occurrs over a channel,
   for which there are two implemnations: websocket(.js) and AJAX
   polling (ajax_polling.js). */

var async = require("async");

var jot = require("jot");

exports.push_interval = 200;

exports.Client = function(owner_name, document_name, api_key, channel, widget, logger) {
  // Our state.
  var closed = false;
  var pushIntervalObj = null;

  // Document/widget state.
  var the_user;
  var initial_peer_states;
  var readonly;
  var widget_base_content;
  var widget_base_revision;
  var is_widget_initialized = false;

  // Ephemeral state.
  var ephemeral_state = null;

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

  // Open the communication channel and initialize the widget asynchronously,
  // wait for both to finish, and then start polling for widget changes.
  async.parallel([
    function(callback) {
      // Open the communication channel.
      logger("opening document using " + channel.name);
      channel.open(owner_name, document_name, api_key, {
        opened: function(user, doc, peer_states, methods) {
          // The document was successfully opened. We've now got
          // its current content and the corresponding revision id.

          if (closed) { methods.close(); callback("already closed"); callback = null; return; } // closed before calledback

          logger("document opened by " + user.name + " with " + doc.access_level + " access");

          // Set global state.
          the_user = user;
          widget_base_content = doc.content;
          widget_base_revision = doc.revision;
          initial_peer_states = peer_states;
          channel_methods = methods;

          // Do we have write access?
          readonly = !(doc.access_level == "WRITE" || doc.access_level == "ADMIN");

          callback(); callback = null;
        },
        pull: function(revisions) {
          // New changes have come in from the server. Append them
          // to the end of remote_changes and then try to process
          // them.
          revisions.forEach(function(rev) { remote_changes.push(rev); })
          if (is_widget_initialized)
            merge_remote_changes();
        },
        peer_state_updated: function(peerid, user, state) {
          widget.on_peer_state_updated(peerid, user, state);
        },
        nonfatal_error: function(message) {
          if (closed) return;
          widget.show_message("warning", message);
        },
        fatal_error: function(message) {
          // if this ocurred during channel open, call the async.parallel callback
          if (callback) callback(message);
          callback = null;

          if (closed) return;
          widget.show_message("error", message);
          close_client();
        }
      });        
    },
    function(callback) {
      // Give the widget some time to initialize.
      widget.initialize(logger, callback);
    }
  ], function(err, results) {
      if (err) {
        alert(err);
        return;
      }

      // Give the widget the initial document state.
      widget.open({
        user: the_user,
        content: widget_base_content,
        readonly: readonly,
        peer_states: initial_peer_states
      });

      // Begin periodically pushing new local changes.
      if (!readonly)
        pushIntervalObj = setInterval(push_local_changes, exports.push_interval);

      // If any changes came in after opening the document but before the widget
      // finished initializing, process them now.
      merge_remote_changes();
      is_widget_initialized = true;
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
    var seen_ours = null;
    var revs_after_ours = [];
    remote_changes.forEach(function(revision) {
      // Pull out our own Revision that was pending when we sent it
      // but now is committed or had an error.
      if (waiting_for_local_change_to_return
          && revision.id == waiting_for_local_change_to_return.revision_id)
        seen_ours = revision;

      // Skip any other Revisions whose status is "error" --- that
      // means another client submitted an invalid Revision. Everyone
      // is notified because there is no way to notify just the submitter.
      else if (revision.status != "committed")
        return;

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

    if (seen_ours && seen_ours.status == "error") {
      // The operation we sent somehow turned out to be invalid.
      // As a result, we probably cannot process anything further.
      // The rebase with anything incoming will likely fail, and
      // so we can't apply any further changes from the server.
      // The only thing to do now is to close the connection and
      // warn the user.
      widget.status("error");
      widget.show_message("error", "There is a problem with the document. Copy any changes you made into a new document. Apologies for the inconvenience.");
      close_client();
      return;
    }

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

    // Let the widget know we are in a saved state now --- there is
    // nothing in the pipeline.
    widget.status("saved");
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
          }
          if (err) {
            // TODO: Restore state to try again later.
            widget.show_message("warning", err);
          }

          // Clear the flag that we've got a change in the channel,
          // and since the pushing state has changed we can now
          // process remote changes if there are any.
          waiting_for_local_change_to_save = false;
          merge_remote_changes();
        })
      }
    }

    // Check if the ephemeral_state changed.
    var es = widget.get_ephemeral_state();
    if (jot.cmp(ephemeral_state, es) != 0) {
      channel_methods.send_state(es);
      ephemeral_state = es;
    }
  }

  function close_client() {
    // Function to shut down the channel and all polling.
    widget.document_closed();
    if (!closed)
      logger("connection closed");
    closed = true;
    if (channel_methods)
      channel_methods.close();
    if (pushIntervalObj)
      clearInterval(pushIntervalObj);
  } 

  return {
    close: close_client
  };
};
        

