exports.name = "Websocket";

exports.open = function(owner_name, document_name, api_key, cbobj) {
  var socket = global.io.connect('/');

  var document_id;
  var access_level;

  socket.on('message', function (message) {
    alert(message)
  });

  socket.emit('open-document', {
    owner: owner_name,
    document: document_name,
    api_key: api_key
  });

  socket.on('document-opened', function (data) {
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
    // TODO: Check data.document == document_id
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

  socket.on('document-patch-received', function (revision) {
    if (revision.error) {
      cb("There was an error submitting a local change: " + revision.error);
      return;
    }

    current_push_cb(null, revision);
  });
}
