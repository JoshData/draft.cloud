var fs = require('fs')
var bodyParser = require('body-parser')
var randomstring = require("randomstring");
var json_ptr = require('json-ptr');

var auth = require("./auth.js");
var models = require("./models.js");

var jot = require("jot");

// Export a function that creates routes on the express app.

exports.create_routes = function(app, settings) {
  // Set defaults for JSON responses.
  app.set("json spaces", 2);

  var api_public_base_url = settings.url;
  var api_path_root = "/api/v1";

  // USER CREATION

  var user_route = api_path_root + '/users/:user';

  app.post(api_path_root + '/users', function (req, res) {
    // Create a new User with an initial, strong API key. Return a
    // redirect to the User's API url but include the API key in a
    // response header.

    auth.check_request_authorization(req, function(req_user, requestor_api_key) {
      if (!req_user && !settings.allow_anonymous_user_creation) {
        res.status(403).send('You are not allowed to create a new user.');
        return;
      }

      // If the API key lowers access...
      if (requestor_api_key && auth.min_access("ADMIN", requestor_api_key.access_level) != "ADMIN") {
        res.status(403).send('You are not allowed to create a new user with this API key.');
        return;
      }

      // Create a new User. If this API call is authenticated, then the new User
      // is owned by the user making the request.
      models.User.create({
        name: randomstring.generate({
          length: 48,
          charset: 'alphanumeric'
        }),
        ownerId: req_user ? req_user.id : 0,
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
      });
    });
  });

  function authz_user(req, res, target_user_name, min_level, cb) {
    // Checks authorization for user URLs. The callback is called
    // as: cb(requestor, target) where requestor is the User making the
    // request and target is User about which the request is being made.
    if (!(min_level == "NONE" || min_level == "READ" || min_level == "WRITE" || min_level == "ADMIN")) throw "invalid argument";
    auth.get_user_authz(req, target_user_name, function(requestor, target, level) {
      // Check permission level.
      if (auth.min_access(min_level, level) != min_level) {
        // The user's access level is lower than the minimum access level required.
        if (auth.min_access("READ", level) == "READ")
          // The user has READ access but a higher level was required.
          res.status(403).send('You do not have ' +  min_level + ' permission for this user. You have ' + level + '.');
        else
          // The user does not have READ access, so we do not reveal whether or not
          // a document exists here.
          res.status(404).send('User not found or you do not have permission to see them.');
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
    // Update's a user.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires ADMIN permission on the user.

    // Validate/sanitize input.
    req.body = models.Document.clean_document_dict(req.body);
    if (typeof req.body == "string")
      return res.status(400).send(req.body);

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
    });
  })

  exports.form_user_response_body = function(user) {
    return {
        id: user.uuid,
        name: user.name,
        profile: user.profile,
        created: user.createdAt,
        api_urls: {
          profile: api_public_base_url + user_route.replace(/:user/, encodeURIComponent(user.name)),
          documents: api_public_base_url + document_list_route.replace(/:owner/, encodeURIComponent(user.name))
        }
      }   
  }


  // DOCUMENT LIST/CREATION/DELETION

  var document_list_route = api_path_root + '/documents/:owner';
  var document_route = document_list_route + '/:document';

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
          res.status(403).send('You do not have ' +  min_level + ' permission on this document. You have ' + level + '.');
        else
          // The user does not have READ access, so we do not reveal whether or not
          // a document exists here.
          res.status(404).send('User or document not found or you do not have permission to see it.');
        return;
      }

      // Check if document exists.
      if (must_exist && !doc) {
        // Document doesn't exist but must. Since the user would at least have READ access
        // if the document existed, or else we would have given a different error above,
        // we can reveal that the document doesn't exist.
        res.status(404).send('Document does not exist.');
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
        length: 48,
        charset: 'alphanumeric'
      }),
      anon_access_level: doc.anon_access_level || auth.DEFAULT_NEW_DOCUMENT_ANON_ACCESS_LEVEL,
      userdata: doc.userdata || {}
    }).then(cb);
  }

  exports.make_document_json = function(owner, doc) {
    return {
      id: doc.uuid,
      name: doc.name,
      anon_access_level: doc.anon_access_level,
      owner: exports.form_user_response_body(owner),
      userdata: doc.userdata,
      api_urls: {
        document: api_public_base_url + document_route.replace(/:owner/, encodeURIComponent(owner.name))
          .replace(/:document/, encodeURIComponent(doc.name)),
        debugger: api_public_base_url + document_route.replace(/:owner/, encodeURIComponent(owner.name))
          .replace(/:document/, encodeURIComponent(doc.name)) + "/debug"
      },
      web_urls: {
        document: api_public_base_url + "/:owner/:document".replace(/:owner/, encodeURIComponent(owner.name))
          .replace(/:document/, encodeURIComponent(doc.name))
      }
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
        paranoid: true // only return non-deleted rows
      })
      .then(function(docs) {
        // Turn the documents into API JSON.
        docs = docs.map(function(item) { return exports.make_document_json(owner, item); });

        // Emit response.
        res
        .status(200)
        .json(docs);
      });
    })
  });

  app.post(document_list_route, bodyParser.json(), function (req, res) {
    // Create a document. A document name may not be specified in the request body ---
    // a unique, random, unguessable name is assigned.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires default ADMIN permission on documents owned by the owner user.
    // Validate/sanitize input.
    req.body = models.Document.clean_document_dict(req.body);
    if (typeof req.body == "string")
      return res.status(400).send(req.body);

    // Check authorization to create the document.
    authz_document(req, res, false, "ADMIN", function(user, owner, doc) {
      exports.create_document(owner, req.body, function(doc) {
        res.status(200).json(exports.make_document_json(owner, doc));
      });
    })
  });

  app.put(document_route, bodyParser.json(), function (req, res) {
    // Create a document or update its metadata.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires ADMIN permission on the document. (If the document doesn't yet
    // exist, we can still have ADMIN permission in virtue of being the same
    // user as the intended owner.)

    // Validate/sanitize input.
    req.body = models.Document.clean_document_dict(req.body);
    if (typeof req.body == "string")
      return res.status(400).send(req.body);

    // Check authorization to create/update the document.
    authz_document(req, res, false, "ADMIN", function(user, owner, doc) {
      if (!doc) {
        // Create a document.
        req.body.name = req.params.document;
        exports.create_document(owner, req.body, finish_request);
      } else {
        // Document exists. Update its metadata from any keys provided.
        if (typeof req.body.name != "undefined")
          doc.set("name", req.body.name);
        if (typeof req.body.anon_access_level != "undefined")
          doc.set("anon_access_level", req.body.anon_access_level);
        if (typeof req.body.userdata != "undefined")
          doc.set("userdata", req.body.userdata);
        doc.save().then(function() {
          finish_request(doc);
        })
      }

      function finish_request(doc) {
        res
        .status(200)
        .json(exports.make_document_json(owner, doc));
      }
    })
  })

  app.get(document_route, function (req, res) {
    // Fetch metadata about a document.
    //
    // Requires READ permission on the document (and the document must exist).
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      res
      .status(200)
      .json(exports.make_document_json(owner, doc));
    })
  })

  app.delete(document_route, function (req, res) {
    // Delete a document.
    //
    // Requires ADMIN permission on the document.
    authz_document(req, res, true, "ADMIN", function(user, owner, doc) {
      // First clear the document's name so that it cannot cause uniqueness
      // constraint violations with a new document of the same name.
      doc.set("name", null);
      doc.save().then(function() {
        doc.destroy().then(function() {
          res.send('document deleted')
        });
      })
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
    })
  })

  app.put(document_route + '/team', bodyParser.json(), function (req, res) {
    // Add, remove, or update a collaborator for this document.
    //
    // Requires ADMIN permission on the document (and the document must exist)
    // and READ permission for the user being added/updated but no permission
    // for the user if they are being removed.

    if (typeof req.body != "object")
      return res.status(400).send(req.body);
    if (!auth.is_access_level(req.body.access_level))
      return res.status(400).send("invalid access level: " + req.body.access_level);

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
            res.status(200).send("no change");
            return;
          } else if (req.body.access_level == "NONE") {
            // Kill an existing permission.
            dp.destroy().then(function() {
                res.status(200).send("removed");
            });
            return;
          }

          if (!dp)
            dp = new models.DocumentPermission();
          dp.documentId = doc.id;
          dp.userId = target.id;
          dp.access_level = req.body.access_level;
          dp.save().then(function(err) {
            res.status(200).send("saved");
          });
        });
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

  var document_content_route = document_route + '/content:pointer(/[\\w\\W]*)?';

  exports.get_document_content = function(doc, pointer, at_revision, save_cached_content, cb) {
    // Get the content of a document (or part of a document) at a particular revision.
    //
    // pointer is null or a string containing a JSON Pointer indicating the part of
    // the document to retrieve.
    //
    // at_revision is null to get the most recent document content, a Revision instance,
    // or "singularity", which represents the state of the document prior to the first
    // Revision.
    //
    // Calls cb(error) or cb(null, revision, content, path), where revision is null
    // representing the "singularity" or a Revision instance or UUID, content is the document
    // content, and path is a data structure similar to the pointer that is used to
    // create JOT operations at that path --- unlike pointer, it distinguishes Array and
    // Object accesses.

    if (at_revision == "singularity") {
      // This is a special value that signals the state of the document
      // prior to the first Revision. The document is always a null value
      // at that state.
      if (pointer)
        cb('Document path ' + pointer + ' cannot exist before the document is started.');
      else
        cb(null, null, null, []);
      return;
    }

    if (typeof at_revision === "string") {
    	// If given a Revision UUID, look it up in the database.
  		exports.load_revision_from_id(doc, at_revision, function(revision) {
  			if (!revision)
		        cb('Invalid revision: ' + at_revision);
		    else
  				exports.get_document_content(doc, pointer, revision, save_cached_content, cb);
  		});
    	return;
    }

    // Find the most recent CachedContent, but no later
    // than at_revision (if at_revision is not null).
    var where = { documentId: doc.id };
    if (at_revision)
      where['revisionId'] = { "$lte": at_revision.id };
    models.CachedContent.findOne({
      where: where,
      order: [["revisionId", "DESC"]],
      include: [{
        model: models.Revision
      }]
    })
    .then(function(cache_hit) {
      // Load all subsequent revisions. Add to the id filter to only get
      // revisions after the cache hit's revision. The cache_hit may be null
      // if there is no available cached content --- in which case
      // we load all revisions from the beginning.
      var where = {
        documentId: doc.id,
        committed: true
      };
      if (at_revision || cache_hit)
        where["id"] = { };
      if (at_revision)
        where['id']["$lte"] = at_revision.id;
      if (cache_hit)
        where['id']["$gt"] = cache_hit.revisionId;
      models.Revision.findAll({
        where: where,
        order: [["id", "ASC"]]
      })
      .then(function(revs) {
        // Documents always start with a null value at the start of the revision history.
        var current_revision = "singularity";
        var content = null;

        // Start with the peg revision, assuming there was one.
        if (cache_hit) {
          content = cache_hit.document_content;
          current_revision = cache_hit.revision;
        }

        // Apply all later revisions' operations (if any).
        for (var i = 0; i < revs.length; i++) {
          var op = jot.opFromJSON(revs[i].op);
          content = op.apply(content);
          current_revision = revs[i];
        }

        // We now have the latest content....

        // If the most recent revision doesn't have cached content,
        // store it so we don't have to do all this work again next time.
        if (revs.length > 0 && save_cached_content) {
          models.CachedContent.create({
                documentId: doc.id,
                revisionId: current_revision.id,
                document_content: content
              }).then(function(user) {
                // we're not waiting for this to finish
              });
        }

        // Execute the JSON Pointer given in the URL. We could use
        // json_ptr.get(content, pointer). But the PUT function needs
        // to know whether the pointer passes through arrays or objects
        // in order to create the correct JOT operations that represent
        // the change. So we have to step through each part and record
        // whether we are passing through an Object or Array.
        var x = parse_json_pointer_path_with_content(pointer, content);
        if (!x)
          cb('Document path ' + pointer + ' not found.');
        op_path = x[0];
        content = x[1];

        // Callback.
        cb(null, current_revision, content, op_path);
      })
      .catch(function(err) {
        cb("There is an error with the document.");
      });
    });
  }

  function parse_json_pointer_path_with_content(pointer, content) {
    // The path is a JSON Pointer which we parse with json-ptr.
    // Unfortunately the path components are all strings, but
    // we need to distinguish array index accessses from object
    // property accesses. We'll distinguish by turning the pointer
    // into an array of strings (for objects) and integers (for
    // arrays). We can only know the difference by looking at
    // an actual document. So we'll step through the path and
    // see if we are passing through arrays or objects.

    var op_path = [ ];
    if (!pointer)
      return [op_path, content];

    for (let item of json_ptr.decodePointer(pointer)) {
      if (Array.isArray(content))
        // This item on the path is an array index. Turn the item
        // into a number.
        op_path.push(parseInt(item));
      else
        // This item is an Object key, so we keep it as a string.
        op_path.push(item)

      // Use json-ptr to process just this part of the path. This way
      // we get its error handling.
      content = json_ptr.get(content, json_ptr.encodePointer([item]));
      if (typeof content == "undefined")
        return null;
    }

    return [op_path, content];
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

    // Parse the path via get_document_content.
    exports.get_document_content(doc, pointer, base_revision, false, function(err, revision, content, op_path) {
      cb(err, op_path);
    });
  }

  app.get(document_content_route, function (req, res) {
    // Fetch (the content of) a document. If a JSON Pointer is given at the end
    // of the path, then only return that part of the document. A JSON document
    // is returned. READ access is required. The Revision-Id header can be used
    // to 
    authz_document_content(req, res, "READ", function(user, owner, doc, access_level) {
      exports.get_document_content(doc,
        req.params.pointer,
        req.headers['Revision-Id'],
        true, // cache the content at this revision
        function(err, revision, content) {

        if (err) {
          res.status(404).send(err);
          return;
        }

        // Send a header with the ID of the revision that this content came from,
        // so that if the user submits new content we know what the base revision was.
        res.header("Revision-Id", revision ? revision.uuid : "singularity")
        res.header("Access-Level", access_level)

        // What content type should be used for the response? Get the preferred
        // content type from the Accept: header, of the content types that we recognize.
        var format = req.accepts(["json", "text"])
        if (!format) {
          // No recognized content type provided.
          res.status(406).send("Invalid content type in Accept: header.");
          return;
        }

        // If the content is not plain text and JSON is acceptable too, then we must return JSON.
        if (format == "text" && typeof content != "string") {
          if (req.accepts(["json"]))
            format = "json";
          else {
            // The document cannot be sent as plain text.
            res.status(406).send("The document is not plain-text.");
            return;
          }
        }

        // Send content - as JSON if JSON is the preferred accepted format.
        if (format == "json")
          res.json(content);

        // Or as text, if text is the preferred accepted format. Coerce the
        // data to a string.
        else if (format == "text")
          res.send(""+content);
        
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

  exports.make_revision = function(user, doc, base_revision, op, pointer, comment, userdata, res) {
    // Record an uncommitted transaction.
    models.Revision.create({
      userId: user.id,
      documentId: doc.id,
      baseRevisionId: base_revision == "singularity" ? null : base_revision.id,
      doc_pointer: pointer,
      op: op.toJSON(),
      comment: comment,
      userdata: userdata
    })
    .then(function(rev) {
      // Send response.
      res.status(201).json(exports.make_revision_response(rev, null));

      // Alert committer to look for new revisions.
      require("./committer.js").notify();
    })
  }

  function drill_down_operation(op, op_path) {
    // Drill down and unwrap the operation.
    op = jot.opFromJSON(op);
    op_path.forEach(function(key) {
      op = op.drilldown(key);
    });
    return op.toJSON();
  }

  exports.make_revision_response = function(rev, op_path) {
    var ret = {
      createdAt: rev.createdAt,
      id: rev.uuid,
      author: rev.userId,
      comment: rev.comment,
      userdata: rev.userdata,
      committed: rev.committed
    };

    if (rev.committed) 
      ret.op = drill_down_operation(rev.op, op_path);

    return ret;
  }

  exports.load_revision_from_id = function(doc, revision_id, cb) {
    // Gets a Revision instance from a revision UUID. If revision_id is...
    //   "singularity", then "singularity"
    //   "", then the most recent revision ("singularity" or a Revision instance)
    //   a revision id, then that one
    //   not valid, then null
    // ... is passed to the callback.

    // If "singularity" is passed, pass it through as a specicial revision.
    if (revision_id == "singularity")
      cb("singularity")

    // Find the named revision.
    else if (revision_id)
      models.Revision.findOne({
        where: { documentId: doc.id, uuid: revision_id },
      })
      .then(function(revision) {
        if (!revision)
          cb(null);
        else
          cb(revision);
      });

    // Get the most recent revision. If there are no revisions yet,
    // pass forward the spcial ID "singularity".
    else
      models.Revision.findOne({
        where: { documentId: doc.id },
        order: [["id", "DESC"]] // most recent
      })
      .then(function(revision) {
        if (!revision)
          cb("singularity");
        else
          cb(revision);
      });
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
      res.status(400).send("Invalid PUT body content type.");
      return;
    }

    // parse the userdata, same as in the PATCH route
    var userdata = null;
    if (req.headers['revision-userdata']) {
      try {
        userdata = JSON.parse(req.headers['revision-userdata']);
      } catch(e) {
        res.status(400).send("Invalid userdata: " + e);
        return;
      }
    }

    // Get the current content and revision of the document.
    authz_document_content(req, res, "WRITE", function(user, owner, doc) {
      // Find the base revision. If not specified, it's the current revision.
      exports.load_revision_from_id(doc, req.headers['base-revision-id'], function(base_revision) {
        // Invalid ID.
        if (!base_revision) {
          res.status(400).send("Invalid base revision ID.")
          return;
        }

        // Get the content of the document as of the base revision.
        exports.get_document_content(doc, req.params.pointer, base_revision, false /* dont cache */, function(err, revision, content, op_path) {
          if (err) {
            res.status(404).send(err);
            return;
          }

          // Diff the base content and the content in the request body to generate a JOT
          // operation.
          make_operation_from_diff(req.params.pointer, content, req.body, function(err, op) {
            if (err)
              res.status(400).send(err);
            else if (!op)
              // The document wasn't changed - don't take any action.
              // (There is a similar response if the result of the rebase is a no-op too.)
              res.status(200).send("no change");
            else
              // Make a new revision.
              exports.make_revision(
                user,
                doc,
                base_revision,
                op,
                req.params.pointer,
                req.headers['revision-comment'],
                userdata,
                res);
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
        res.status(400).send(err)
      }

      // parse the userdata, same as in the PUT route
      var userdata = null;
      if (req.headers['revision-userdata']) {
        try {
          userdata = JSON.parse(req.headers['revision-userdata']);
        } catch(e) {
          res.status(400).send("Invalid userdata: " + e);
          return;
        }
      }

      // check authz
      authz_document_content(req, res, "WRITE", function(user, owner, doc) {
        // Find the base revision. If not specified, it's the current revision.
        exports.load_revision_from_id(doc, req.headers['base-revision-id'], function(base_revision) {
          // Invalid base revision ID.
          if (!base_revision) {
            res.status(400).send("Invalid base revision ID.")
            return;
          }

          // Make a new revision.
          exports.make_revision(
            user,
            doc,
            base_revision,
            op,
            req.params.pointer,
            req.headers['revision-comment'],
            userdata,
            res);
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
      exports.load_revision_from_id(doc, req.query['since'] || "singularity", function(base_revision) {
        // Invalid ID.
        if (!base_revision) {
          res.status(400).send("Invalid base revision ID.")
          return;
        }

        // Fetch revisions since the base revision.
        var where = {
          documentId: doc.id,
          committed: true
        };
        if (base_revision != "singularity")
          where['id'] = { "$gt": base_revision.id };
        models.Revision.findAll({
          where: where,
          order: [["id", "ASC"]]
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
              res.status(400).send(err)
              return;
            }

            // Decode JSON and re-map to the API output format.
            revs = revs.map(function(rev) {
              return exports.make_revision_response(rev, op_path);
            });

            // Filter out no-op revisions, which are operations
            // that only applied to parts of the document outside
            // of the specified path.
            revs = revs.filter(function(rev) {
              return rev.op._type.class != "NO_OP";
            })

            res.json(revs);
          })
        })
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
      res.status(200).send(mustache.render(debug_template, {
        "user": user,
        "owner": owner,
        "document": doc
      }))
    })
  })
}
