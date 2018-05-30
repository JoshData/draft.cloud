var fs = require('fs')
var bodyParser = require('body-parser')
var randomstring = require("randomstring");
var json_ptr = require('json-ptr');
const Sequelize = require('sequelize');

var auth = require("./auth.js");
var models = require("./models.js");
var committer = require("./committer.js");

var jot = require("jot");

// Create a test server.
exports.start_test_server = function(cb) {
  // Start the HTTP server.
  var http = require('http');
  var express = require('express');
  models.initialize_database({ database: "sqlite::memory:" }, function() {
    // Config.
    var bind_host = "127.0.0.1";
    var bind_port = 8001;
    var baseurl = "http://" + bind_host + ":" + bind_port;

    // Start the HTTP server.
    var app = express();
    exports.create_routes(app, {
      url: baseurl,
      allow_anonymous_user_creation: true
    });

    // Start listening.
    var server = http.createServer(app);
    server.listen(bind_port, bind_host);
    server.on('listening', function() {
      console.log("Test server started on " + bind_host + ":" + bind_port + ".");
      cb(bind_host, bind_port, function() {
        console.log("Shutting down test server.");
        server.close();
      })
    });
  });
}

function res_send_plain(res, status_code, message) {
  res
    .status(status_code)
    .set('Content-Type', 'text/plain')
    .send(message)
    .end();
}

function unhandled_error_handler(res) {
  return (function(err) {
    console.log("-------------------" + "-".repeat(res.req.url.length))
    console.log("UNHANDLED ERROR at", res.req.url);
    console.log(err);
    console.log("-------------------" + "-".repeat(res.req.url.length))
    res_send_plain(res, 500, 'An internal error occurred.');
  });
}

// Export a function that creates routes on the express app.

exports.create_routes = function(app, settings) {
  // Set defaults for JSON responses.
  app.set("json spaces", 2);

  var api_public_base_url = settings.url;
  var api_path_root = "/api/v1";

  // AUTHORIZATION MIDDLEWARE

  app.use(function(req, res, next) {
    if (req.headers['authorization'])
      models.UserApiKey.validateApiKey(
        req.headers['authorization'],
        function(user, user_api_key) {
          req.user = user;
          req.user_api_key = user_api_key;
          next();
      });
    else
      next();
  })

  // USER CREATION

  var user_route = api_path_root + '/users/:user';

  app.post(api_path_root + '/users', function (req, res) {
    // Create a new User with an initial, strong API key. Return a
    // redirect to the User's API url but include the API key in a
    // response header.

    auth.check_request_authorization(req, function(req_user, requestor_api_key) {
      if (!req_user && !settings.allow_anonymous_user_creation) {
        res_send_plain(res, 403, 'You are not allowed to create a new user.');
        return;
      }

      // If the API key lowers access...
      if (requestor_api_key && auth.min_access("ADMIN", requestor_api_key.access_level) != "ADMIN") {
        res_send_plain(res, 403, 'You are not allowed to create a new user with this API key.');
        return;
      }

      // Create a new User. If this API call is authenticated, then the new User
      // is owned by the user making the request.
      models.User.create({
        name: randomstring.generate({
          length: 22, // about 128 bits, same as the user's UUID
          charset: 'alphanumeric'
        }),
        ownerId: req_user ? req_user.id : null,
      }).then(function(user) {
        // Create an initial API key for this user.
        models.UserApiKey.createApiKey(user, .001, function(obj, api_key) {
          // Give the key ADMIN access to the User's own account.
          obj.set("access_level", "ADMIN");
          obj.save();

          res
            .header("X-Api-Key", api_key)
            .status(200)
            .json(exports.form_user_response_body(user));
        });
      }).catch(unhandled_error_handler(res));
    });
  });

  function authz_user(req, res, target_user_id, min_level, cb) {
    // Checks authorization for user URLs. The callback is called
    // as: cb(requestor, target) where requestor is the User making the
    // request and target is User about which the request is being made.
    if (!(min_level == "NONE" || min_level == "READ" || min_level == "WRITE" || min_level == "ADMIN")) throw "invalid argument";
    auth.get_user_authz(req, target_user_id, function(requestor, target, level) {
      // Check permission level.
      if (auth.min_access(min_level, level) != min_level) {
        // The user's access level is lower than the minimum access level required.
        if (auth.min_access("READ", level) == "READ")
          // The user has READ access but a higher level was required.
          res_send_plain(res, 403, 'You do not have ' +  min_level + ' permission for this user. You have ' + level + '.');
        else
          // The user does not have READ access, so we do not reveal whether or not
          // a document exists here.
          res_send_plain(res, 404, 'User not found or you do not have permission to see them.');
        return;
      }

      // All good.
      cb(requestor, target);
    });
  }

  app.get(user_route, function (req, res) {
    // Gets information about the user. The requesting user must have READ
    // permission on the user.
    authz_user(req, res, req.params.user, "READ", function(requestor, target) {
      res
      .status(200)
      .json(exports.form_user_response_body(target));
    });
  });

  app.put(user_route, bodyParser.json(), function (req, res) {
    // Updates a user.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires ADMIN permission on the user.

    // Validate/sanitize input.
    req.body = models.User.clean_user_dict(req.body);
    if (typeof req.body == "string")
      return res_send_plain(res, 400, req.body);

    authz_user(req, res, req.params.user, "ADMIN", function(requestor, target) {
      // Update user's globally unique name.
      if (typeof req.body.name != "undefined")
        target.set("name", req.body.name);

      if (typeof req.body.profile != "undefined")
        target.set("profile", req.body.profile);
      
      target.save().then(function() {
        res
        .status(200)
        .json(exports.form_user_response_body(target));
      })
      .catch(err => {
        try {
          if (err.name == "SequelizeUniqueConstraintError" && err.fields.indexOf("name") >= 0) {
            res_send_plain(res, 400, 'There is already a user with that name.');
            return;
          }
        } catch (e) {
          unhandled_error_handler(res)
        }
      });
    });
  })

  exports.form_user_response_body = function(user) {
    return {
        id: user.uuid,
        name: user.name,
        profile: user.profile,
        created: user.createdAt,
        api_urls: {
          profile: api_public_base_url + user_route.replace(/:user/, user.uuid),
          documents: api_public_base_url + document_list_route.replace(/:owner/, user.uuid)
        }
      }   
  }


  // DOCUMENT LIST/CREATION/DELETION

  var document_list_route = api_path_root + '/documents/:owner';
  var document_route = document_list_route + '/:document';
  var document_content_route = document_route + '/content:pointer(/[\\w\\W]*)?';

  function authz_document(req, res, must_exist, min_level, cb) {
    // Checks authorization for document URLs. The callback is called
    // as: cb(user, owner, document) where user is the user making the
    // request, owner is the owner of the document, and document is the
    // document.
    if (!(min_level == "READ" || min_level == "WRITE" || min_level == "ADMIN")) throw "invalid argument";
    auth.get_document_authz(req, req.params.owner, req.params.document, function(user, owner, doc, level) {
      // Check permission level.
      if (auth.min_access(min_level, level) != min_level) {
        // The user's access level is lower than the minimum access level required.
        if (auth.min_access("READ", level) == "READ")
          // The user has READ access but a higher level was required.
          res_send_plain(res, 403, 'You do not have ' +  min_level + ' permission on this document. You have ' + level + '.');
        else
          // The user does not have READ access, so we do not reveal whether or not
          // a document exists here.
          res_send_plain(res, 404, 'User or document not found or you do not have permission to see it.');
        return;
      }

      // Check if document exists.
      if (must_exist && !doc) {
        // Document doesn't exist but must. Since the user would at least have READ access
        // if the document existed, or else we would have given a different error above,
        // we can reveal that the document doesn't exist.
        res_send_plain(res, 404, 'Document does not exist.');
        return;
      }

      // All good.
      cb(user, owner, doc, level);
    });
  }

  exports.create_document = function(owner, doc, cb) {
    // Create a new document.
    models.Document.create({
      userId: owner.id,
      name: doc.name || randomstring.generate({
        length: 22, // about 128 bits, same as the user's UUID
        charset: 'alphanumeric'
      }),
      anon_access_level: doc.anon_access_level || auth.DEFAULT_NEW_DOCUMENT_ANON_ACCESS_LEVEL,
      userdata: doc.userdata || {}
    })
    .then(function(doc) {
      doc.user = owner; // fill in
      cb(doc);
    })
    .catch(function(err) {
       cb(null, err);
    });
  }

  exports.make_document_json = function(doc) {
    return {
      id: doc.uuid,
      name: doc.name,
      created: doc.createdAt,
      anon_access_level: doc.anon_access_level,
      owner: exports.form_user_response_body(doc.user),
      userdata: doc.userdata,
      api_urls: {
        document: api_public_base_url + document_route.replace(/:owner/, doc.user.uuid)
          .replace(/:document/, doc.uuid),
        content: api_public_base_url + document_content_route.replace(/:owner/, doc.user.uuid)
          .replace(/:document/, doc.uuid).replace(/:pointer.*/, ''),
        history: api_public_base_url + document_route.replace(/:owner/, doc.user.uuid)
          .replace(/:document/, doc.uuid) + "/history",
        debugger: api_public_base_url + document_route.replace(/:owner/, doc.user.uuid)
          .replace(/:document/, doc.uuid) + "/debug"
      },
      web_urls: {
        document: settings.url + "/edit/:owner/:document".replace(/:owner/, doc.user.name)
          .replace(/:document/, doc.name)
      },
      currentContent: doc.currentContent, // used by frontend
      currentRevision: doc.currentRevision, // used by frontend
    };
  }

  app.get(document_list_route, function (req, res) {
    // Get all documents owned by the owner.
    //
    // Check that the caller has a default READ permission on
    // documents owned by this owner. That should mean that the caller
    // must be the owner.
    authz_document(req, res, false, "READ", function(user, owner, doc) {
      var docs = models.Document.findAll({
        where: {
          userId: owner.id
        },
        include: [
          { model: models.User }
        ]
      })
      .then(function(docs) {
        // Turn the documents into API JSON.
        docs = docs.map(exports.make_document_json);

        // Emit response.
        res
        .status(200)
        .json(docs);
      })
      .catch(unhandled_error_handler(res));
    })
  });

  app.post(document_list_route, bodyParser.json(), function (req, res) {
    // Create a document.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires default ADMIN permission on documents owned by the owner user.
    // Validate/sanitize input.
    req.body = models.Document.clean_document_dict(req.body);
    if (typeof req.body == "string")
      return res_send_plain(res, 400, req.body);

    // Check authorization to create the document.
    authz_document(req, res, false, "ADMIN", function(user, owner, doc) {
      exports.create_document(owner, req.body, function(doc, err) {
        if (err) {
          unhandled_error_handler(res)(err);
          return;
        }
        res.status(200).json(exports.make_document_json(doc));
      });
    })
  });

  app.put(document_route, bodyParser.json(), function (req, res) {
    // Update document metadata.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires ADMIN permission on the document.

    // Validate/sanitize input.
    req.body = models.Document.clean_document_dict(req.body);
    if (typeof req.body == "string")
      return res_send_plain(res, 400, req.body);

    // Check authorization to update the document.
    authz_document(req, res, true, "ADMIN", function(user, owner, doc) {
      // Document exists. Update its metadata from any keys provided.
      if (typeof req.body.name != "undefined")
        doc.set("name", req.body.name);
      if (typeof req.body.anon_access_level != "undefined")
        doc.set("anon_access_level", req.body.anon_access_level);
      if (typeof req.body.userdata != "undefined")
        doc.set("userdata", req.body.userdata);
      doc.save().then(function() {
        res
        .status(200)
        .json(exports.make_document_json(doc));
      })
      .catch(err => {
        try {
          if (err.name == "SequelizeUniqueConstraintError" && err.fields.indexOf("name") >= 0) {
            res_send_plain(res, 400, 'There is already a document with that name.');
            return;
          }
        } catch (e) {
          unhandled_error_handler(res)
        }
      });
    })
  })

  app.get(document_route, function (req, res) {
    // Fetch metadata about a document.
    //
    // Requires READ permission on the document (and the document must exist).
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      res
      .status(200)
      .json(exports.make_document_json(doc));
    })
  })

  app.delete(document_route, function (req, res) {
    // Delete a document.
    //
    // Requires ADMIN permission on the document.
    authz_document(req, res, true, "ADMIN", function(user, owner, doc) {
      // First clear the document's name so that it cannot cause uniqueness
      // constraint violations with a new document of the same name since
      // the database row isn't actually deleted.
      doc.set("name", null);
      doc.save().then(function() {
        doc.destroy().then(function() {
          res_send_plain(res, 200, 'document deleted');
        });
      })
      .catch(unhandled_error_handler(res));
    })
  })

  // DOCUMENT PERMISSIONS

  app.get(document_route + '/team', function (req, res) {
    // Fetch the collaborators for this document.
    //
    // Requires READ permission on the document (and the document must exist).
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      // Fetch all team members.
      models.DocumentPermission.findAll({
        where: {
          documentId: doc.id
        },
        include: [{
          model: models.User
        }]
      }).then(function(team) {
        // Remove the owner since we'll add them back at the top.
        team = team.filter(function(member) { return member.id != owner.id; })

        // Format for public fields.
        team = team.map(function(member) { return { id: memer.user.uuid, name: member.user.name, access_level: member.level }; })

        // Add the owner at the top.
        team = [{ id: user.uuid, name: user.name, access_level: "owner" }]
                  .concat(team);

        res
        .status(200)
        .json(team);
      })
      .catch(unhandled_error_handler(res));
    })
  })

  app.put(document_route + '/team', bodyParser.json(), function (req, res) {
    // Add, remove, or update a collaborator for this document.
    //
    // Requires ADMIN permission on the document (and the document must exist)
    // and READ permission for the user being added/updated but no permission
    // for the user if they are being removed.

    if (typeof req.body != "object")
      return res_send_plain(res, 400, req.body);
    if (!auth.is_access_level(req.body.access_level))
      return res_send_plain(res, 400, "invalid access level: " + req.body.access_level);

    authz_document(req, res, true, "ADMIN", function(user, owner, doc) {
      authz_user(req, res, req.body.user, req.body.access_level != "NONE" ? "READ" : "NONE", function(_, target) {
        // Get any existing permsision.
        models.DocumentPermission.findOne({
          where: {
            documentId: doc.id,
            userId: target.id
          }
        }).then(function(dp) {
          if (!dp && req.body.access_level == "NONE") {
            // No permission and none requested - nothing to do.
            res_send_plain(res, 200, "no change");
            return;
          } else if (req.body.access_level == "NONE") {
            // Kill an existing permission.
            dp.destroy().then(function() {
                res_send_plain(res, 200, "removed");
            });
            return;
          }

          if (!dp)
            dp = new models.DocumentPermission();
          dp.documentId = doc.id;
          dp.userId = target.id;
          dp.access_level = req.body.access_level;
          dp.save().then(function(err) {
            res_send_plain(res, 200, "saved");
          })
          .catch(unhandled_error_handler(res))
        })
        .catch(unhandled_error_handler(res))
      });
    })
  })


  // DOCUMENT CONTENT AND HISTORY

  function authz_document_content(req, res, min_level, cb) {
    // Checks authorization for document content URLs.
    authz_document(req, res, true, min_level, function(user, owner, doc, access_level) {
      cb(user, owner, doc, access_level);
    })
  }

  function parse_json_pointer_path(doc, pointer, base_revision, cb) {
    // Parse the "pointer", which is a JSON Pointer to a part of a
    // document. The only way to get a path we can process is to get
    // actual document content at a revision and see if the components
    // of the path are through arrays or objects.
    if (!pointer) {
      // If there is no pointer path, just provide an empty op path.
      cb(null, [])
      return;
    }

    // Parse the path via doc.get_content.
    doc.get_content(pointer, base_revision, false, function(err, revision, content, op_path) {
      cb(err, op_path);
    });
  }

  app.get(document_content_route, function (req, res) {
    // Fetch (the content of) a document. If a JSON Pointer is given at the end
    // of the path, then only return that part of the document. A JSON document
    // is returned. READ access is required.
    authz_document_content(req, res, "READ", function(user, owner, doc, access_level) {
      doc.get_content(
        req.params.pointer,
        req.headers['revision-id'],
        true, // cache the content at this revision
        function(err, revision, content) {

        if (err) {
          res_send_plain(res, 404, err);
          return;
        }

        // Send a header with the ID of the revision that this content came from,
        // so that if the user submits new content we know what the base revision was.
        res.header("Revision-Id", revision ? revision.uuid : "singularity")

        // Send the user's access level in a header so the user knows what operations
        // are permitted on the document.
        res.header("Access-Level", access_level)

        // What content type should be used for the response? Get the preferred
        // content type from the Accept: header, of the content types that we recognize.
        var format = req.accepts(["json", "text"])
        if (!format) {
          // No recognized content type provided.
          res_send_plain(res, 406, "Invalid content type in Accept: header.");
          return;
        }

        // If the content is not plain text and JSON is acceptable too, then we must return JSON.
        if (format == "text" && typeof content != "string") {
          if (req.accepts(["json"]))
            format = "json";
          else {
            // The document cannot be sent as plain text.
            res_send_plain(res, 406, "The document is not plain-text.");
            return;
          }
        }

        // Send content - as JSON if JSON is the preferred accepted format.
        if (format == "json")
          res.json(content);

        // Or as text, if text is the preferred accepted format. Coerce the
        // data to a string.
        else if (format == "text")
          res_send_plain(res, 200, ""+content);
        
      });
    })
  })

  function make_operation_from_diff(pointer, old_content, new_content, cb) {
    // Compute the JOT operation to transform the old content to the new content.
    var op = jot.diff(old_content, new_content);

    // Don't make a revision if there was no change.
    if (op.isNoOp()) {
      cb();
      return;
    }

    // Callback.
    cb(null, op);
  }

  function drill_down_operation(op, op_path, noop_to_null) {
    // Drill down and unwrap the operation.
    if (op_path.length == 0)
      return op;
    op = jot.opFromJSON(op);
    op_path.forEach(function(key) {
      op = op.drilldown(key);
    });
    if (noop_to_null && op.isNoOp())
      return null;
    return op.toJSON();
  }

  exports.make_revision_response = function(rev, op_path, noop_to_null) {
    var ret = {
      created: rev.createdAt,
      id: rev.uuid,
      author: {
        id: rev.user.uuid,
        name: rev.user.name
      },
      comment: rev.comment,
      userdata: rev.userdata
    };

    if (rev.committed) {
      ret.status = "committed";
      ret.op = drill_down_operation(rev.op, op_path, noop_to_null);
      if (ret.op == null)
        return null;
    } else if (rev.error) {
      ret.status = "error";
    } else {
      ret.status = "pending";
    }

    return ret;
  }

  app.put(
    document_content_route,
    [
      // parse application/json bodies
      bodyParser.json({
        limit: "10MB", // maximum payload size
        strict: false // allow documents that are just strings, numbers, or null
      }),

      // parse text/plain bodies
      bodyParser.text({
        limit: "10MB" // maximum payload size
      })
    ],
    function (req, res) {
    // Replace the document with new content. If a JSON Pointer is given at the end
    // of the path, then replace that part of the document only. The PUT body must
    // be JSON or plain text, with an appropriate Content-Type header.
    // WRITE access is required.

    // Validate/parse input.

    if (!req._body) {
      // _body is set when bodyparser parses a body. If it's not truthy, then
      // we did not get a valid content-type header.
      res_send_plain(res, 400, "Invalid PUT body content type.");
      return;
    }

    // parse the userdata, same as in the PATCH route
    var userdata = null;
    if (req.headers['revision-userdata']) {
      try {
        userdata = JSON.parse(req.headers['revision-userdata']);
      } catch(e) {
        res_send_plain(res, 400, "Invalid userdata: " + e);
        return;
      }
    }

    // Get the current content and revision of the document.
    authz_document_content(req, res, "WRITE", function(user, owner, doc) {
      // Find the base revision. If not specified, it's the current revision.
      models.Revision.from_uuid(doc, req.headers['base-revision-id'], function(base_revision) {
        // Invalid ID.
        if (!base_revision) {
          res_send_plain(res, 400, "Invalid base revision ID.")
          return;
        }

        // Get the content of the document as of the base revision.
        doc.get_content(req.params.pointer, base_revision, false /* dont cache */, function(err, revision, content, op_path) {
          if (err) {
            res_send_plain(res, 404, err);
            return;
          }

          // Diff the base content and the content in the request body to generate a JOT
          // operation.
          make_operation_from_diff(req.params.pointer, content, req.body, function(err, op) {
            if (err)
              res_send_plain(res, 400, err);
            else if (!op)
              // The document wasn't changed - don't take any action.
              // (There is a similar response if the result of the rebase is a no-op too.)
              res_send_plain(res, 200, "no change");
            else
              // Make a new revision.
              committer.make_revision_sync(
                user,
                doc,
                base_revision,
                op,
                req.params.pointer,
                req.headers['revision-comment'],
                userdata,
                function(err, rev) {
                  if (err)
                    unhandled_error_handler(res)
                  else
                    res.status(201).json(exports.make_revision_response(rev, []));
                })
          })
        });

      });
    })
  })

  app.patch(
    document_content_route,
    [
      // parse application/json bodies
      bodyParser.json({
        limit: "10MB", // maximum payload size
        strict: true // allow only JSON objects
      }),
    ],
    function (req, res) {
      // Apply changes to a document. The changes are given as JSON-serialized JOT
      // operations. If a JSON Pointer is given at the end of the path, the operations
      // are relative to that location in the document. WRITE access is required.

      // Parse the operation.
      var op;
      try {
        op = jot.opFromJSON(req.body);
      } catch (err) {
        res_send_plain(res, 400, err);
        return;
      }

      // parse the userdata, same as in the PUT route
      var userdata = null;
      if (req.headers['revision-userdata']) {
        try {
          userdata = JSON.parse(req.headers['revision-userdata']);
        } catch(e) {
          res_send_plain(res, 400, "Invalid userdata: " + e);
          return;
        }
      }

      // check authz
      authz_document_content(req, res, "WRITE", function(user, owner, doc) {
        // Find the base revision. If not specified, it's the current revision.
        models.Revision.from_uuid(doc, req.headers['base-revision-id'], function(base_revision) {
          // Invalid base revision ID.
          if (!base_revision) {
            res_send_plain(res, 400, "Invalid base revision ID.")
            return;
          }

          // Make a new revision.
          committer.make_revision_sync(
            user,
            doc,
            base_revision,
            op,
            req.params.pointer,
            req.headers['revision-comment'],
            userdata,
            function(err, rev) {
              if (err)
                unhandled_error_handler(res)
              else
                res.status(201).json(exports.make_revision_response(rev, []));
            })
        });
      })
    }
  )

  app.get(document_route + '/history', function (req, res) {
    // Gets the history of a document. The response is a list of changes, in
    // chronological order (oldest first). If ?since= is in the URL, then the
    // revisions are only returned after that revision.
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      // Get the base revision. If not specified, it's the start of
      // the document history.
      models.Revision.from_uuid(doc, req.query['since'] || "singularity", function(base_revision) {
        // Invalid ID.
        if (!base_revision) {
          res_send_plain(res, 400, "Invalid base revision ID.")
          return;
        }

        // Fetch revisions since the base revision.
        var where = {
          documentId: doc.id,
          committed: true
        };
        if (base_revision != "singularity")
          where['id'] = { [Sequelize.Op.gt]: base_revision.id };
        models.Revision.findAll({
          where: where,
          order: [["id", "ASC"]],
          include: [{
            model: models.User
          }]
        })
        .then(function(revs) {
          // Parse the "pointer" parameter, which is a JSON Pointer to the
          // part of the document that the caller wants the history for.
          // The only way to get a path we can process is to get the
          // actual document content at a revision.
          parse_json_pointer_path(
            doc,

            // no need to actually parse a path if there are no revisions
            // to return - parsing a path is expensive
            revs.length > 0 ? req.query['path'] : null,

            // revision at a point the path exists
            base_revision,

            function(err, op_path) {

            // Error parsing path.
            if (err) {
              res_send_plain(res, 400, err)
              return;
            }

            // Decode JSON and re-map to the API output format,
            // dropping revisions that are no-ops on the path if
            // a path was given.
            revs = revs.map(function(rev) {
              return exports.make_revision_response(rev, op_path, op_path.length > 0);
            });
            revs = revs.filter(function(rev) {
              return rev != null; // no-op
            });

            res.json(revs);
          })
        })
        .catch(unhandled_error_handler(res))
      });
    })
  })

  app.get(document_route + '/history/:revision', function (req, res) {
    // Gets the revision. Useful for checking if a revision was committed.
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      models.Revision.from_uuid(doc, req.params.revision, function(revision) {
        // Invalid ID.
        if (!revision) {
          res_send_plain(res, 400, "Invalid revision ID.")
          return;
        }
        res.json(exports.make_revision_response(revision, []));
      });
    })
  })

  var debug_template = fs.readFileSync("templates/document_debug.html", "utf8");
  app.get(document_route + "/debug", function (req, res) {
    // Show a debug page for the document.
    //
    // Requires READ permission on the document (and the document must exist).
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      var mustache = require("mustache");
      res
      .status(200)
      .set('Content-Type', 'text/html')
      .send(mustache.render(debug_template, {
        "user": user,
        "owner": owner,
        "document": doc
      }))
    })
  })
}
