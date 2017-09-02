exports.name = "Websocket";

var socket = null;

exports.open = function(owner_name, document_name, api_key, cbobj) {
  // On first use, add the socket.io script tag.
  var elem = document.createElement('script');
  elem.src = "/socket.io/socket.io.js";
  elem.onload = function() {
    // Once the script loads, we can open a websocket.
    open(owner_name, document_name, api_key, cbobj);
  }
  document.getElementsByTagName('head')[0].appendChild(elem);
}

function open(owner_name, document_name, api_key, cbobj) {
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
        // This could be an error on first connection or on reconnection.
        cbobj.fatal_error(response.error);
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
          },
          response.peer_states,
          {
            push: push,
            send_state: send_state,
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

  function send_state(new_state) {
    socket.emit('update-state', {
      document: document_id,
      state: new_state
    });
  }

  socket.on('peer-state', function (data) {
    if (data.document != document_id) return; // for a different open-document stream
    if (data.state == null) data.state = { user: null, state: null }; // peer disconnected
    cbobj.peer_state_updated(data.peer, data.state.user, data.state.state);
  });
}
