exports.name = "Websocket";

var socket = null;

exports.open = function(owner_name, document_name, api_key, cbobj) {
  if (!socket) {
    socket = global.io('/');
    socket.on('message', function (message) {
      alert(message)
    });
  }

  var document_id;
  var access_level;

  socket.emit('open-document', {
    owner: owner_name,
    document: document_name,
    api_key: api_key
  }, function(response) {
    if (response.error) {
      cbobj.error(response.error);
      return;
    }

    document_id = response.document.id;
    access_level = response.access_level;

    cbobj.opened({
        content: response.content,
        revision: response.revision,
        access_level: access_level,
        pushfunc: push,
        closefunc: function() {
          socket.emit('close-document', {
            document: document_id
          });
        }
      }
    );
  });

  socket.on('new-revisions', function (data) {
    if (data.document != document_id) return; // for a different open-document stream
    cbobj.pull(data.revisions);
  });

  function push(base_revision, patch, cb) {
    // The Client class calls this function to submit a JOT operation to
    // the server. The server will record an *uncommitted* Revision and
    // send that back in the socket callback function.
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
