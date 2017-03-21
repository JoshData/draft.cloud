/* This module defines an implementation of the "channel" interface which
   manages communications with draft.cloud server. */

function document_url(owner_name, document_name, path) {
  return "/api/v1/documents/:owner:/:document:/:path:"
    .replace(":owner:", owner_name)
    .replace(":document:", document_name)
    .replace(":path:", path);
}

exports.idle_poll_interval = 3000;
exports.active_poll_interval = 1000;
exports.error_poll_interval = 10000;

exports.name = "AJAX Polling";

exports.open = function(owner_name, document_name, api_key, cbobj) {
  // Load the document's current content.
  $.ajax({
    url: document_url(owner_name, document_name, "content"),
    dataType: "json",
    headers: {
      'Authorization': api_key
    },
    success: function(document_content, status, xhr) {
      // Create a state object is a closure object that
      // we hold on to so that our poll function can advance
      // the base revision each time we receive more history.
      var poll_state = {
        closed: false,
        last_revision_received: xhr.getResponseHeader("Revision-Id")
      };

      // Pass the initial document content to the callback,
      // which lets the caller know the channel is open.
      cbobj.opened({
          content: document_content,
          revision: xhr.getResponseHeader("Revision-Id"),
          access_level: xhr.getResponseHeader("Access-Level"),
          pushfunc: push,
          closefunc: function() { poll_state.closed = true; }
        }
      );

      // Kick off the polling for remote changes to this document.
      // (Actually we get our changes echoed back to us too.)
      function poll_remote_changes() {
        // If this channel has been closed, then don't poll and don't
        // schedule any future polls.
        if (poll_state.closed)
          return;

        // Hit the /history URL to get any new remote changes.
        $.ajax({
          url: document_url(owner_name, document_name, "history"),
          method: "GET",
          dataType: "json",
          data: {
            since: poll_state.last_revision_received
          },
          headers: {
            'Authorization': api_key
          },
          success: function(history, status, xhr) {
            if (!history.length) {
              // No changes. Poll again in a little while.
              setTimeout(poll_remote_changes, exports.idle_poll_interval);
              return;
            }

            // There were changes. Send them to the caller.
            cbobj.pull(history);
            poll_state.last_revision_received = history[history.length-1].id;
            
            // Run this again in a little while.
            setTimeout(poll_remote_changes, exports.active_poll_interval);
          },
          error: function(msg) {
            // Run this again in a little while.
            cbobj.nonfatal_error("There was an error polling for remote changes: " + msg);
            setTimeout(poll_remote_changes, exports.error_poll_interval);
          }
        })
      }
      poll_remote_changes(); // kick it off

      // Define the push function to send new changes to the server.
      function push(base_revision, patch, cb) {
        $.ajax({
          url: document_url(owner_name, document_name, "content"),
          method: "PATCH",
          data: patch.serialize(),
          
          // could also dump the whole document content and let the
          // server figure out the differences, which will be better
          // for client CPU but worse for network usage
          //method: "PUT",
          //data: JSON.stringify(content),

          contentType: "application/json",
          headers: {
            'Authorization': api_key,
            'Base-Revision-Id': base_revision
          },
          dataType: "json",
          success: function(revision, status, xhr) {
            // The response is a new Revision object for this patch.
            cb(null, revision);
          },
          error: function(msg) {
            cb(msg)
          }
        });
      }

    },
    error: function(msg) {
      // An error at this point is fatal.
      cbobj.error(msg)
    }
  });
}
