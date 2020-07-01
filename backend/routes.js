var fs = require('fs')
var bodyParser = require('body-parser')
var randomstring = require("randomstring");
var json_ptr = require('json-ptr');
const Sequelize = require('sequelize');

var auth = require("./auth.js");
var models = require("./models.js");
var committer = require("./committer.js");
var merge = require("./merge.js");

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
    exports.add_middleware(app);
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

// Export a function that adds authz middleware. All middleware
// must be added before routes it is used in, and we want the
// Authorization API key header check to work for the front-end
// routes too, so we separate it.

exports.add_middleware = function(app) {
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
}

// Export a function that creates routes on the express app.

exports.create_routes = function(app, settings) {
  // Set defaults for JSON responses.
  app.set("json spaces", 2);

  var api_public_base_url = settings.url;
  var api_path_root = "/api/v1";

  // USER CREATION

  var user_route = api_path_root + '/users/:user';

  app.post(api_path_root + '/users', bodyParser.json(), function (req, res) {
    // Create a new User with an initial, strong API key. Return the usual user
    // data but include the API key in a separate response header.

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

      // Validate/sanitize the request body which contains initial
      // User object fields.
      // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
      // default restrictions on the request body payload.
      req.body = models.User.clean_user_dict(req.body);
      if (typeof req.body != "object") req.body = { };

      // Make a random name if one isn't provided by the user.
      if (!req.body.name) {
        req.body.name = randomstring.generate({
          length: 22, // about 128 bits, same as the user's UUID
          charset: 'alphanumeric'
        });   
      }

      // Create a new User. If this API call is authenticated, then the new User
      // is owned by the user making the request.
      models.User.create({
        name: req.body.name,
        profile: req.body.profile,
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
      }).catch(function(err) {
        var handler = unhandled_error_handler(res);
        if (err.errors && err.errors[0].path == "name") {
          // Validation failed --- probably because the 'name' was already
          // taken by a user.
          res_send_plain(res, 400, "Name already taken.");
          return;
        }
        if (err.errors) {
          // Validation failed --- probably because the 'name' was already
          // taken by a user.
          res_send_plain(res, 400, err.errors.map(x => { return x.message; }).join("; "));
          return;
        }
        handler(err);
      });
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
      // Also see the POST route.

      // Update user's globally unique name.
      if (typeof req.body.name != "undefined")
        target.set("name", req.body.name);

      // Update the user's profile data.
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
        }
        unhandled_error_handler(res)(err);
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

  function authz_document2(req, res, document_owner_id, document_id, must_exist, min_level, error_msg_descr, cb) {
    // Checks authorization for document URLs. The callback is called
    // as: cb(user, owner, document) where user is the user making the
    // request, owner is the owner of the document, and document is the
    // document.
    if (!(min_level == "READ" || min_level == "WRITE" || min_level == "ADMIN")) throw "invalid argument";
    auth.get_document_authz(req, document_owner_id, document_id, function(user, owner, doc, level) {
      // Check permission level.
      if (auth.min_access(min_level, level) != min_level) {
        // The user's access level is lower than the minimum access level required.
        if (auth.min_access("READ", level) == "READ")
          // The user has READ access but a higher level was required.
          res_send_plain(res, 403, 'You do not have ' +  min_level + ' permission on the document ' + error_msg_descr + '. You have ' + level + ' permission.');
        else
          // The user does not have READ access, so we do not reveal whether or not
          // a document exists here.
          res_send_plain(res, 404, 'User or document ' + error_msg_descr + ' not found or you do not have permission to see it.');
        return;
      }

      // The user has or would have the right level of access to the document.
      // Check if the document actually exists.
      if (must_exist && !doc) {
        // Document doesn't exist but must. Since the user would at least have READ access
        // if the document existed, or else we would have given a different error above,
        // we can reveal that the document doesn't exist.
        res_send_plain(res, 404, 'Document ' + error_msg_descr + ' does not exist.');
        return;
      }

      // All good.
      cb(user, owner, doc, level);
    });
  }

  function authz_document(req, res, must_exist, min_level, cb) {
    authz_document2(req, res, req.params.owner, req.params.document, must_exist, min_level, "in the URL", cb);
  }

  exports.create_document = function(owner, doc, cb) {
    // If doc.forkedFrom is given and it is not a Revision, then
    // resolve the UUID to a Revision instance.
   if (doc.forkedFrom && !(doc.forkedFrom instanceof models.Revision)) {
      // If "singularity" is given, it's not really forking at all.
      if (doc.forkedFrom == "singularity") {
        delete doc.forkedFrom;
      } else {
        models.Revision.from_uuid(null, doc.forkedFrom, function(revision) {
          if (!revision) {
            cb(null, "forkedFrom was not a valid revision id.")
            return;
          }
          doc.forkedFrom = revision;
          exports.create_document(owner, doc, cb);
        });
        return;
      }
    }

    // Create a new document.
    models.Document.create({
      userId: owner.id,
      name: doc.name || randomstring.generate({
        length: 22, // about 128 bits, same as the user's UUID
        charset: 'alphanumeric'
      }),
      forkedFromId: doc.forkedFrom ? doc.forkedFrom.id : null,
      anon_access_level: doc.anon_access_level || auth.DEFAULT_NEW_DOCUMENT_ANON_ACCESS_LEVEL,
      userdata: doc.userdata || {}
    })
    .then(function(newdoc) {
      newdoc.user = owner; // fill in
      newdoc.forkedFrom = doc.forkedFrom; // fill in
      cb(newdoc);
    })
    .catch(function(err) {
       cb(null, err);
    });
  }

  exports.make_document_json = function(doc) {
    // doc must have been fetched from the database using
    // `include: exports.Document.INCLUDES` so that it has
    // all of the JOIN'd fields used below.
    return {
      id: doc.uuid,
      name: doc.name,
      created: doc.createdAt,
      anon_access_level: doc.anon_access_level,
      owner: exports.form_user_response_body(doc.user),
      forkedFrom: !doc.forkedFrom ? null : {
        // Don't expose possibly private data of the forked document,
        // and don't recurse into the forked document because it may
        // also be a fork.
        owner: doc.forkedFrom.document.user.uuid,
        document: doc.forkedFrom.document.uuid,
        revision: doc.forkedFrom.uuid,
        revisionCreated: doc.forkedFrom.createdAt,
        api_urls: {
          document: api_public_base_url + document_route.replace(/:owner/, doc.forkedFrom.document.user.uuid)
            .replace(/:document/, doc.forkedFrom.document.uuid)
          }
      },
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
        include: models.Document.INCLUDES
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
          try {
            if (err.name == "SequelizeUniqueConstraintError" && err.fields.indexOf("name") >= 0) {
              res_send_plain(res, 400, 'There is already a document with that name.');
              return;
            }
          } catch (e) {
          }
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
          unhandled_error_handler(res)(err);
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
    // Fetch the content of a document. If a JSON Pointer is given at the end
    // of the path, then only return that part of the document. A JSON document
    // is returned unless the accept header specifies otherwise. READ access is required.
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
      userdata: rev.userdata
    };
    if (rev.merges) {
      // Don't expose possibly private data of the revision from the
      // document that was merged in.
      ret['merges'] = {
        // Don't expose possibly private data of the forked document,
        // and don't recurse into the forked document because it may
        // also be a fork.
        owner: rev.merges.document.user.uuid,
        document: rev.merges.document.uuid,
        revision: rev.merges.uuid,
        revisionCreated: rev.merges.createdAt
      };
    }

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

  function parse_revision_userdata(req) {
    // Parse the JSON-encoded Revision-Userdata header, if present.
    var userdata = null;
    if (req.headers['revision-userdata'])
      userdata = JSON.parse(req.headers['revision-userdata']);

    // Parse strings from Revision-Userdata-* headers. If one is
    // encountered and userdata is null, upgrade it to an object.
    // If userdata has already been parsed as a non-object value,
    // ignore these headers.
    for (let k in req.headers) {
      var m = /^revision-userdata-(.*)$/.exec(k);
      if (!m) continue;
      var key = m[1];
      var value = req.headers[k];
      if (userdata === null) userdata = { };
      if (typeof userdata != "object") continue;
      userdata[key] = value;
    }

    return userdata;
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

    // parse the userdata, same as in the PATCH route and merge
    var userdata = null;
    try {
      userdata = parse_revision_userdata(req);
    } catch(e) {
      res_send_plain(res, 400, "Invalid userdata: " + e);
      return;
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
              res_send_plain(res, 204); // 204 is No Content
            else
              // Make a new revision.
              committer.save_revision({
                user,
                doc,
                base_revision,
                op,
                pointer: req.params.pointer,
                userdata
                },
                function(err, rev) {
                  if (err)
                    unhandled_error_handler(res)(err);
                  else
                    res.status(200).json(exports.make_revision_response(rev, []));
                });
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

      // parse the userdata, same as in the PUT route and merge
      var userdata = null;
      try {
        userdata = parse_revision_userdata(req);
      } catch(e) {
        res_send_plain(res, 400, "Invalid userdata: " + e);
        return;
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
          committer.save_revision({
            user,
            doc,
            base_revision,
            op,
            pointer: req.params.pointer,
            userdata
            },
            function(err, rev) {
              if (err)
                unhandled_error_handler(res)(err);
              else
                res.status(200).json(exports.make_revision_response(rev, []));
            })
        });
      })
    }
  )

  function get_merge_data(req, res, target_document_permission_level, cb) {
    // Check authorization on the main document --- the user must have READ or WRITE permission as provided.
    authz_document_content(req, res, target_document_permission_level, function(user, owner, doc) {
      // Load the current revision of the document. We call it the
      // base_revision because it is the revision that we will form
      // operations against to commit.
      models.Revision.from_uuid(doc, null, function(base_revision) {
        // Load the revision specified in the URL, which tells us the document
        // whose changes are to be merged in.
        models.Revision.from_uuid(null, req.params.revision, function(source_revision) {
          // Invalid revision ID.
          if (!source_revision) {
            res_send_plain(res, 400, "Invalid revision ID.")
            return;
          }

          // Check the authorization on the source document, i.e. the one
          // with changes to merge in --- the user must have READ access.
          // Even though we already have model instances, we pass the ids
          // because that's what the authorization check function uses.
          authz_document2(req, res, source_revision.document.user.uuid, source_revision.document.uuid, true, "READ", "to merge", function(_, source_owner, source_doc) {
            cb(user, owner, doc, base_revision, source_owner, source_doc, source_revision);
          });
        });
      });
    });
  }

  app.get(
    document_route + "/merge/:revision",
    function (req, res) {
      // Get the changes that would be made to merge the changes in another
      // document up to the given revision (it's a peg for the most recent
      // revision in that document to merge, not a pointer to the changes
      // themselves to merge) into the document. Return the JOT operation
      // that would be committed if POST were called instead.
      get_merge_data(req, res, "READ", function(user, target_owner, target_doc, base_revision, source_owner, source_doc, source_revision) {
        merge.compute_merge_operation(target_doc, base_revision, source_doc, source_revision, function(err, op, dual_op) {
          if (err) {
            unhandled_error_handler(res)(err);
            return;
          }
          res.status(200).json({
            op: op.toJSON()
          });
        })
      })
    }
  )

  app.post(
    document_route + "/merge/:revision",
    function (req, res) {
      // Merge the changes in the document up to the given revision (it's a
      // peg for the most recent revision to merge, not a pointer to the
      // changes themselves to merge) into the document.

      // parse the userdata for the commit, same as in the content POST and PUT routes
      var userdata = null;
      try {
        userdata = parse_revision_userdata(req);
      } catch(e) {
        res_send_plain(res, 400, "Invalid userdata: " + e);
        return;
      }

      get_merge_data(req, res, "WRITE", function(user, target_owner, target_doc, base_revision, source_owner, source_doc, source_revision) {
        merge.compute_merge_operation(target_doc, base_revision, source_doc, source_revision, function(err, op, dual_op) {
          if (err) {
            unhandled_error_handler(res)(err);
            return;
          }

          // Commit the change.
          committer.save_revision({
            user,
            doc: target_doc,
            base_revision,
            op,
            userdata,
            merges_revision: source_revision,
            merges_op: dual_op
            },
            function(err, rev) {
              if (err)
                unhandled_error_handler(res)(err);
              else
                res.status(200).json(exports.make_revision_response(rev, []));
          });
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
          include: models.Revision.INCLUDES
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

  var debug_template = fs.readFileSync("frontend/templates/document_debug.html", "utf8");
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
