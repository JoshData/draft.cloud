// Websocket API.

var expressCookieParser = require('cookie-parser');
const Sequelize = require('sequelize');

var jot = require("jot");
var auth = require("./auth.js");
var models = require("./models.js");
var routes = require("./routes.js");

var document_watchers = {
  _map: { },

  add: function(doc, socket) {
    if (!(doc in this._map))
      this._map[doc] = [ ];
    this._map[doc].push(socket);
    console.log("doc", doc, "now watched by", socket.id);
  },
  remove: function(doc, socket) {
    if (doc in this._map) {
      console.log("doc", doc, "no longer watched by", socket.id);
      this._map[doc] = this._map[doc].filter(function(s) { return s !== socket });
    }
  },
  get: function(doc) {
    if (doc in this._map)
      return this._map[doc];
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
    socket.on('open-document', function (data, response) {
      // We get the owner and document names. Convert those to UUIDs because
      // auth.get_document_authz wants UUIDs. TODO: Once we have these records,
      // there is no need to do a second look-up in auth.get_document_authz.
      models.User.findOne({ where: { name: data.owner }})
      .then(function(owner) {
        models.Document.findOne({ where: { userId: owner ? owner.id : -1, name: data.document }})
        .then(function(document) {
          data.owner = owner ? owner.uuid : "-invalid-";
          data.document = document ? document.uuid : "-invalid-";
          open_document(data, response);
        });      
      });      
    });

    function open_document(data, response) {
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
          response({ error: "You do not have permission to read this document."});
          return;
        }

        if (doc.uuid in socket.open_documents) {
          // Can't open the same document more than once.
          response({ error: "Document is already open." });
          return;
        }

        // Sufficient permission.... Get the document's current content
        // and/or the Revision corresponding to what this reconnecting
        // client last saw.
        doc.get_content(
          data.path,
          data.last_seen_revision, // null or the last revision seen before disconnect
          true, /* cache, many people might be reconnecting here */
          function(err, revision, content, op_path) {
            if (err) {
              response({ error: err });
              return;
            }

            // Get the current peer state of everyone else connected.
            var peer_states = { };
            document_watchers.get(doc.uuid).forEach(function(peer_socket) {
              peer_states[peer_socket.id] = make_peer_state(peer_socket.open_documents[doc.uuid]);
            });

            // Send.
            response({
              user: routes.form_user_response_body(user),
              document: routes.make_document_json(owner, doc),
              access_level: level,
              content: content,
              revision: revision ? revision.uuid : "singularity",
              peer_states: peer_states
            });

            // If reconnecting, send all of the revisions that ocurred while the
            // user was off-line.
            if (data.last_seen_revision) {
              models.Revision.findAll({
                where: {
                  documentId: doc.id,
                  id: { [Sequelize.Op.gt]: revision.id },
                  committed: true
                },
                order: [["id", "ASC"]],
                include: [{
                  model: models.User
                }]
              })
              .then(function(revs) {
                socket.emit("new-revisions", {
                  document: doc.uuid,
                  revisions: revs.map(function(rev) { return routes.make_revision_response(rev, op_path) })
                });
              });
            }

            // Add this socket to the global object containing all sockets listening
            // to documents.
            socket.open_documents[doc.uuid] = {
              user: user, // who authenticated
              document: doc,
              doc_pointer: data.path,
              op_path: op_path,
              last_seen_revision: revision,
              ephemeral_state: null
            };
            document_watchers.add(doc.uuid, socket);

          });
      });
    };

    function make_peer_state(state) {
      return {
        user: { id: state.user.uuid, name: state.user.name, display_name: state.user.profile && state.user.profile.display_name },
        state: state.ephemeral_state,
      }
    }

    socket.on('document-patch', function (data, response) {
      // This is just like the PATCH route but without authorization because we already
      // did that.

      // Is the document open?
      if (!(data.document in socket.open_documents))
        return;

      // TODO Error handling.

      // Parse the operation.
      var op = jot.opFromJSON(data.patch);

      // Load the document.
      var doc_state = socket.open_documents[data.document];

      // Add the widget state to the userdata.
      var userdata = (data.userdata || {});
      userdata.widget_state = { };
      userdata.widget_state[socket.id] = data.widget_state;

      // Find the base revision. If not specified, it's the current revision.
      models.Revision.from_uuid(doc_state.document, data.base_revision, function(base_revision) {
        routes.make_revision(
          doc_state.user,
          doc_state.document,
          base_revision,
          op,
          doc_state.doc_pointer,
          data.comment,
          userdata,
          {
            _status: null,
            status: function(code) { this._status = code; return this; },
            send: function(message) {
              // An error ocurred.
              response({ error: message, code: this._status });
            },
            json: function(data) {
              response({
                revision: data
              });
            }
          });
      });
    });

    socket.on('update-state', function (data) {
      // Set the user's ephemeral state and broadcast it to everyone listening.
      if (!(data.document in socket.open_documents))
        return;

      // Update state.
      socket.open_documents[data.document].ephemeral_state = data.state;

      // Broadcast it (but not to ourself).
      document_watchers.get(data.document).forEach(function(peer_socket) {
        if (peer_socket == socket) return;
        peer_socket.emit("peer-state", {
          document: data.document,
          peer: socket.id,
          state: make_peer_state(socket.open_documents[data.document])
        });
      })
    });

    function close_document(uuid) {
      document_watchers.remove(uuid, socket)

      // Broadcast that the peer is gone.
      document_watchers.get(uuid).forEach(function(peer_socket) {
        peer_socket.emit("peer-state", {
          document: uuid,
          peer: socket.id,
          state: null
        });
      });
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
  document_watchers.get(doc.uuid).forEach(function(socket) {
    // Notify this client about this new set of revisions.
    var state = socket.open_documents[doc.uuid];
    console.log("notifying", socket.id, "about", doc.uuid);

    // There is a race condition between what was sent to the user when
    // their connection was established and new revisions that follow.
    // A revision might be committed after document content is fetched
    // but before the client is able to receive notifications of new
    // revisions. In that case, catch them up here.
    if (state.last_seen_revision) {
      // Find any revisions that have ocurred.
      models.Revision.findAll({
        where: {
          documentId: doc.id,
          committed: true,
          id: {
            [Sequelize.Op.gt]: state.last_seen_revision.id,
            [Sequelize.Op.lt]: revs[0].id
          }
        },
        order: [["id", "ASC"]],
        include: [{
          model: models.User
        }]
      }).then(function(earlier_revs) {
        // Emit all of the earlier ones, plus the new ones.
        emit_the_revisions(earlier_revs.concat(revs));
      })
      delete state.last_seen_revision;
      return;
    }

    emit_the_revisions(revs);

    //

    function emit_the_revisions(revs) {
      socket.emit("new-revisions", {
        document: doc.uuid,
        revisions: revs.map(function(rev) { return routes.make_revision_response(rev, state.op_path) })
      });
    }
  })
}
