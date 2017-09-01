exports.name = "Websocket";

var socket = null;

exports.open = function(owner_name, document_name, api_key, cbobj) {
  if (!socket) {
    socket = global.io('/');

    socket.on('message', function (message) {
      alert(message)
    });
  }

  var socket_is_open = false;
  var socket_reconnect_actions = [];

  var is_first_open = true;
  var document_id;
  var access_level;
  var last_seen_revision = null;

  socket.on("connect", function() {
    // Open the document, or re-open after a reconnection.
    socket.emit('open-document', {
      owner: owner_name,
      document: document_name,
      api_key: api_key,
      last_seen_revision: last_seen_revision
    }, function(response) {
      if (response.error) {
        cbobj.error(response.error); // note: could be a call in a reconnection
        return;
      }

      document_id = response.document.id;
      access_level = response.access_level;

      // On the first open, pass back document information
      // to the Client object.
      if (is_first_open) {
        is_first_open = false;
        cbobj.opened(
          response.user,
          {
            content: response.content,
            revision: response.revision,
            access_level: access_level
          }, {
            push: push,
            close: function() {
              socket.emit('close-document', {
                document: document_id
              });
            }
          }
        );
      }

      // Execute all of the functions waiting on reconnection.
      socket_is_open = true;
      socket_reconnect_actions.forEach(function(item) {
        item();
      })
      socket_reconnect_actions = [];
    });
  });

  // Track that we're now disconnected.
  socket.on("disconnect", function() {
    socket_is_open = false;
  });


  socket.on('new-revisions', function (data) {
    if (data.document != document_id) return; // for a different open-document stream
    cbobj.pull(data.revisions);
    last_seen_revision = data.revisions[data.revisions.length-1].id;
  });

  function push(base_revision, patch, cb) {
    // The Client class calls this function to submit a JOT operation to
    // the server. The server will record an *uncommitted* Revision and
    // send that back in the socket callback function.
    
    // socket.io handles reconnecting if a connection drops, but if we
    // send a message when the connection is dropped the message goes
    // into a black hole. 
    if (!socket_is_open) {
      // If the socket isn't open, just queue a call to this function
      // with the same arguments for when the socket reconnects.
      socket_reconnect_actions.push(function() {
        push(base_revision, patch, cb);
      })
      return;
    }

    socket.emit('document-patch', {
      document: document_id,
      base_revision: base_revision,
      patch: patch.toJSON(),
      comment: null,
      userdata: null
    }, function(data) {
      if (data.error) {
        cb("There was an error submitting a local change: " + data.error);
        return;
      }

      cb(null, data.revision);
    });
  }    
}
