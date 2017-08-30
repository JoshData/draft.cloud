// Websocket API.

var expressCookieParser = require('cookie-parser');

var jot = require("../jot");
var auth = require("./auth.js");
var models = require("./models.js");
var routes = require("./routes.js");

var document_watchers = {
  _map: { },

  add: function(doc, socket) {
    if (!(doc.uuid in this._map))
      this._map[doc.uuid] = [ ];
    this._map[doc.uuid].push(socket);
    console.log("doc", doc.uuid, "now watched by", socket.id);
  },
  remove: function(document_uuid, socket) {
    if (document_uuid in this._map) {
      console.log("doc", document_uuid, "no longer watched by", socket.id);
      this._map[document_uuid] = this._map[document_uuid].filter(function(s) { return s !== socket });
    }
  },
  get: function(doc) {
    if (doc.uuid in this._map)
      return this._map[doc.uuid];
    else
      return [];
  }
};

exports.init = function(io, sessionStore, settings) {

  // Pull express session information from the connection request.
  // Adapted from https://github.com/leeroybrun/socketio-express-sessions/blob/master/server.js.
  var cookieParser = expressCookieParser(settings.secret_key);
  var EXPRESS_SID_KEY = 'connect.sid';
  io.use(function(socket, next) {
    var request = socket.request;
    if (!request.headers.cookie)
      return next();
    cookieParser(request, {}, function(parseErr) {
      if (parseErr) return next();
      var sidCookie = (request.secureCookies && request.secureCookies[EXPRESS_SID_KEY]) ||
                      (request.signedCookies && request.signedCookies[EXPRESS_SID_KEY]) ||
                      (request.cookies && request.cookies[EXPRESS_SID_KEY]);
      sessionStore.load(sidCookie, function(err, session) {
        if (err) return next();
        if (session && session.passport && session.passport.user) {
          models.User.findById(session.passport.user)
            .then(function(user) {
              socket.handshake.user = user;
              next();
          });
          return;
        }
        return next();
      });
    });
  });


  io.sockets.on('connection', function (socket) {
    // Set state.
    socket.open_documents = { };
    
    // The open-document message begins a connection to monitor a document for
    // real time changes.
    socket.on('open-document', function (data) {
      // Check that the requestor has READ permission. socket.handshake has
      // a 'headers' property that auth.get_document_authz expects for finding
      // the user's API key, which works out if the web browser knows to send
      // that header. (It'll come on websocket requests too.) But if an API key
      // is specified in the socket's message, use that.
      if (data.api_key)
        req_ish = { headers: { authorization: data.api_key } }
      else
        req_ish = socket.handshake;
      auth.get_document_authz(req_ish, data.owner, data.document, function(user, owner, doc, level) {
        if (auth.min_access("READ", level) != "READ") {
          // No READ permission. Fatal.
          socket.emit('message', "403");
          socket.disconnect();
          return;
        }

        // Sufficient permission. Now get the document's current content.
        routes.get_document_content(doc,
          data.path,
          null, // current revision
          function(err, revision_id, content, op_path) {
            if (err) {
              socket.emit('message', err);
              socket.disconnect();
              return;
            }

            if (doc.uuid in socket.open_documents) {
              socket.emit('message', 'Document is already open.');
              socket.disconnect();
              return;
            }

            // Assign a key to this document for the client, so that the client
            // can keep multiple documents open.
            socket.emit('document-opened', {
              requestid: data.requestid,
              document: routes.make_document_json(owner, doc),
              access_level: level,
              content: content,
              revision: revision_id
            });

            // Add this socket to the global object containing all sockets listening
            // to documents.
            socket.open_documents[doc.uuid] = {
              user: user, // who authenticated
              doc_pointer: data.path,
              op_path: op_path,
              last_revision_sent: revision_id
            };
            document_watchers.add(doc, socket);
          });
      });
    });

    socket.on('document-patch', function (data) {
      // This is just like the PATCH route but without authorization because we already
      // did that.

      // Is the document open?
      if (!(data.document in socket.open_documents))
        return;

      // TODO Error handling.

      // Parse the operation.
      var op = jot.opFromJSON(data.patch);

      // Load the document.
      models.Document.findOne({
        where: {
          uuid: data.document
        }}).then(function(doc) {

        var doc_state = socket.open_documents[doc.uuid];

        // Find the base revision. If not specified, it's the current revision.
        routes.load_revision_from_id(doc, data.base_revision, function(base_revision) {
          routes.make_revision(
            doc_state.user,
            doc,
            base_revision,
            op,
            doc_state.doc_pointer,
            data.comment,
            data.userdata,
            {
              _status: null,
              status: function(code) { this._status = code; return this; },
              send: function(message) {
                socket.emit('document-patch-received', { document: doc.uuid, error: message, code: this._status });
              },
              json: function(data) {
                socket.emit('document-patch-received', {
                  document: doc.uuid,
                  revision: data
                });
              }
            });
        });
      })
    });

    function close_document(uuid) {
      document_watchers.remove(uuid, socket)
    }

    socket.on('close-document', function (data) {
      close_document(data.document);
    });
    
    socket.on('disconnect', function() {
      // Remove this socket from the global object containing all sockets listening
      // for document changes.
      Object.keys(socket.open_documents).forEach(close_document);
    });
  });
};

exports.emit_revisions = function(doc, revs) {
  // Send this revision out to all websockets listening on this document.
  //console.log("notifying about", doc.uuid, "...");
  document_watchers.get(doc).forEach(function(socket) {
    console.log("notifying", socket.id, "about", doc.uuid);
    var state = socket.open_documents[doc.uuid];
    socket.emit("new-revisions", {
      document: doc.uuid,
      revisions: revs.map(function(rev) { return routes.make_revision_response(rev, state.op_path) })
    });

    /*
    // Emit all of the revisions from the last one the client saw
    // up through this one to avoid race conditions.
    models.Revision.findAll({
      where: {
        documentId: revision.documentId,
        id: {
          "$gt": state.last_revision_sent,
          "$lte": revision.id
        }
      },
      order: [["id", "ASC"]]
    }).then(function(revs) {
      if (revs.length == 0)
        return;
      var revs = revs.map(function(rev) {
        rev.op = JSON.parse(rev.op);
        rev.userdata = JSON.parse(rev.userdata);          
        return make_revision_response(rev, state.op_path);
      });
      console.log(socket.id, revs)
      socket.emit("new-revisions", revs);
      state.last_revision_sent = revs[revs.length-1].id;
    })
    */
  })
}