exports.name = "Websocket";

var socket = null;

exports.open = function(owner_name, document_name, api_key, cbobj) {
  if (!socket) {
    socket = global.io.connect('/');
    socket.on('message', function (message) {
      alert(message)
    });
    socket.streamcount = 0;
  }

  var document_id;
  var access_level;

  var requestid = ++socket.streamcount;

  socket.emit('open-document', {
    requestid: requestid,
    owner: owner_name,
    document: document_name,
    api_key: api_key
  });

  socket.on('document-opened', function (data) {
    if (data.requestid != requestid) return; // for a different open-document request

    document_id = data.document.id;
    access_level = data.access_level;

    cbobj.opened({
        content: data.content,
        revision: data.revision,
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

  var current_push_cb;

  function push(base_revision, patch, cb) {
    current_push_cb = cb;
    socket.emit('document-patch', {
      document: document_id,
      base_revision: base_revision,
      patch: patch.toJSON(),
      comment: null,
      userdata: null
    });
  }    

  socket.on('document-patch-received', function (data) {
    if (data.document != document_id) return; // for a different open-document stream

    if (data.error) {
      cb("There was an error submitting a local change: " + data.error);
      return;
    }

    current_push_cb(null, data.revision);
  });
}
