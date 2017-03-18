var bodyParser = require('body-parser')
const uuid = require('uuid');
var json_ptr = require('json-ptr');

var auth = require("./auth.js");
var models = require("./models.js");

var jot = require("../jot");

// Export a function that creates routes.

exports.create_routes = function(app) {
  // Set defaults for JSON responses.
  app.set("json spaces", 2);

  var api_public_base_url = "https://draft.cloud";
  var api_path_root = "/api/v1";

  var document_route = api_path_root + '/documents/:owner/:document';

  // DOCUMENT CREATION/DELETION

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
      cb(user, owner, doc);
    });
  }

  function create_document(owner, doc, cb) {
    // Create a new document.
    models.Document.create({
      userId: owner.id,
      name: doc.name,
      anon_access_level: doc.anon_access_level || auth.DEFAULT_NEW_DOCUMENT_ANON_ACCESS_LEVEL,
      userdata: doc.userdata || {}
    }).then(cb);
  }

  function make_document_json(owner, doc) {
    return {
      uuid: doc.uuid,
      name: doc.name,
      anon_access_level: doc.anon_access_level,
      owner: {
        uuid: owner.uuid,
        name: owner.name
      },
      userdata: doc.userdata,
      "api_url": api_public_base_url
        + document_route.replace(/:owner/, encodeURIComponent(owner.name))
          .replace(/:document/, encodeURIComponent(doc.name))
    };
  }

  app.get(api_path_root + '/documents/:owner', function (req, res) {
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
        docs = docs.map(function(item) { return make_document_json(owner, item); });

        // Emit response.
        res
        .status(200)
        .json(docs);
      });
    })
  });

  app.post(api_path_root + '/documents/:owner', bodyParser.json(), function (req, res) {
    // Create a document. A document name may not be specified in the request body ---
    // a unique, random, unguessable name is assigned.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires ADMIN permission on the hypothetical document.
    // Validate/sanitize input.
    req.body = models.Document.clean_document_dict(req.body);
    if (typeof req.body == "string")
      return res.status(400).send(req.body);

    // Check authorization to create the document.
    authz_document(req, res, false, "ADMIN", function(user, owner, doc) {
      req.body.name = uuid.v4();
      create_document(owner, req.body, function(doc) {
        res.redirect(document_route
          .replace(/:owner/, encodeURIComponent(owner.name))
          .replace(/:document/, encodeURIComponent(doc.name)));
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
        create_document(owner, req.body, finish_request);
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
        .json(make_document_json(owner, doc));
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
      .json(make_document_json(owner, doc));
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

  // DOCUMENT CONTENT AND HISTORY

  function authz_document_content(req, res, min_level, cb) {
    // Checks authorization for document content URLs.
    authz_document(req, res, true, min_level, function(user, owner, doc) {
      cb(user, owner, doc);
    })
  }

  var document_content_route = document_route + '/content:pointer(/[\\w\\W]*)?';

  function get_document_content(doc, pointer, at_revision, cb) {
    // Get the content of a document (or part of a document) at a particular revision.
    //
    // pointer is null or a string containing a JSON Pointer indicating the part of
    // the document to retrieve.
    //
    // at_revision is null to get the most recent document content, a Revision instance,
    // or "singularity", which represents the state of the document prior to the first
    // Revision.
    //
    // Calls cb(error) or cb(null, revision_id, content, path), where revision_id
    // is "singularity" or a Revision UUID, content is the document content, and
    // path is a data structure similar to the pointer that is used to create
    // JOT operations at that path --- unlike pointer, it distinguishes Array and
    // Object accesses.

    if (at_revision == "singularity") {
      // This is a special value that signals the state of the document
      // prior to the first Revision. The document is always a null value
      // at that state.
      if (pointer)
        cb('Document path ' + pointer + ' cannot exist before the document is started.');
      else
        cb(null, at_revision, null, []);
      return;
    }

    // Documents always start with a null value at the start of the revision history.
    var revision_id = "singularity";
    var content = null;

    // Find the most recent Revision with cached content, but no later
    // than at_revision (if at_revision is not null).
    var where = {
      documentId: doc.id,
      has_cached_document: true
    };
    if (at_revision)
      where['id'] = { "$lte": at_revision.id };
    models.Revision.findOne({
      where: where,
      order: [["id", "DESC"]]
    })
    .then(function(peg_revision) {
      // Load all subsequent revisions. Add to the id filter to only get
      // revisions after the peg revision. The peg_revision may be null
      // if there are no revisions with cached content --- in which case
      // we load all revisions from the beginning.
      var where = {
        documentId: doc.id,
      };
      if (at_revision || peg_revision)
        where["id"] = { };
      if (at_revision)
        where['id']["$lte"] = at_revision.id;
      if (peg_revision)
        where['id']["$gt"] = peg_revision.id;
      models.Revision.findAll({
        where: where,
        order: [["id", "ASC"]]
      })
      .then(function(revs) {
        // Start with the peg revision, assuming there was one.
        if (peg_revision) {
          content = JSON.parse(peg_revision.cached_document);
          revision_id = peg_revision.uuid;
        }

        // Apply all later revisions' operations (if any).
        for (var i = 0; i < revs.length; i++) {
          var op = jot.opFromJSON(JSON.parse(revs[i].op));
          content = op.apply(content);
          revision_id = revs[i].uuid;
        }

        // We now have the latest content....

        // If the most recent revision doesn't have cached content,
        // store it so we don't have to do all this work again next time.
        if (revs.length > 0) {
          var last_rev = revs[revs.length-1];
          last_rev.set("has_cached_document", true);
          last_rev.set("cached_document", content);
          last_rev.save().then(function() {
            // hmm, ignoring this callback
          })
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
        cb(null, revision_id, content, op_path);
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
    get_document_content(doc, pointer, base_revision, function(err, revision_id, content, op_path) {
      cb(err, op_path);
    });
  }

  app.get(document_content_route, function (req, res) {
    // Fetch (the content of) a document. If a JSON Pointer is given at the end
    // of the path, then only return that part of the document. A JSON document
    // is returned. READ access is required. The Revision-Id header can be used
    // to 
    authz_document_content(req, res, "READ", function(user, owner, doc) {
      get_document_content(doc,
        req.params.pointer,
        req.headers['Revision-Id'],
        function(err, revision_id, content) {

        if (err) {
          res.status(404).send(err);
          return;
        }

        // Send a header with the ID of the revision that this content came from,
        // so that if the user submits new content we know what the base revision was.
        res.header("Revision-Id", revision_id)

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

  function make_revision(user, doc, base_revision, op, op_path, comment, userdata, res) {
    // If this operation occurred at a sub-path on the document, then wrap the
    // operation within APPLY operations to get down to that path. op_path has been
    // constructed so that the elements are either numbers or strings, and jot.APPLY
    // will use that distinction to select whether it is the APPLY for sequences
    // (the element is a number, an index) or objects (the element is a string, a key).
    for (var i = op_path.length-1; i >= 0; i--)
      op = jot.APPLY(op_path[i], op);

    // Rebase against all of the subsequent operations after the base revision to
    // the current revision. Find all of the subsequent operations.
    models.Revision.findAll({
      where: {
        documentId: doc.id,
        id: {
          "$gt": base_revision == "singularity" ? 0 : base_revision.id,
        }
      },
      order: [["id", "ASC"]]
    }).then(function(revs) {
      // Load the JOT operations as a LIST.
      var base_ops = jot.LIST(revs.map(function(rev) {
        return jot.opFromJSON(JSON.parse(rev.op));
      })).simplify();

      // Rebase.
      op = op.rebase(base_ops, true);
      if (op === null) {
        res.status(409).send("The document was modified. Changes could not be applied.")
        return;
      }
      if (op.isNoOp()) {
        res.status(200).send("no change");
        return;
      }

      // Make a revision.
      models.Revision.create({
        userId: user.id,
        documentId: doc.id,
        op: op.toJSON(),
        comment: comment,
        userdata: userdata
      }).then(function(rev) {
        res.status(201).json(make_revision_response(rev, op_path));
      });
    })
  }

  function drill_down_operation(op, op_path) {
    // Drill down and unwrap the operation.
    op = jot.opFromJSON(op);
    op_path.forEach(function(key) {
      op = jot.UNAPPLY(op, key);
    });
    return op.toJSON();
  }

  function make_revision_response(rev, op_path) {
    return {
      createdAt: rev.createdAt,
      uuid: rev.uuid,
      op: drill_down_operation(rev.op, op_path),
      author: rev.userId,
      comment: rev.comment,
      userdata: rev.userdata
    };
  }

  function load_revision_from_id(doc, revision_id, cb) {
    // Gets a Revision instance from a revision UUID. If revision_id is...
    //   "singularity", then "singularity"
    //   "", then the most recent revision
    //   a revision id, then the revision object
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
      load_revision_from_id(doc, req.headers['base-revision-id'], function(base_revision) {
        // Invalid ID.
        if (!base_revision) {
          res.status(400).send("Invalid base revision ID.")
          return;
        }

        // Get the content of the document as of the base revision.
        get_document_content(doc, req.params.pointer, base_revision, function(err, revision_id, content, op_path) {
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
              make_revision(
                user,
                doc,
                base_revision,
                op,
                op_path,
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
        load_revision_from_id(doc, req.headers['base-revision-id'], function(base_revision) {
          // Invalid base revision ID.
          if (!base_revision) {
            res.status(400).send("Invalid base revision ID.")
            return;
          }

          // Parse the JSON Pointer path. If there's a path, the operation
          // applies to the value at that path only. The pointer must exist
          // at the base revision.
          parse_json_pointer_path(doc, req.params.pointer, base_revision, function(err, op_path) {
            // Error parsng path.
            if (err) {
              res.status(400).send(err)
              return;
            }

            // Make a new revision.
            make_revision(
              user,
              doc,
              base_revision,
              op,
              op_path,
              req.headers['revision-comment'],
              userdata,
              res);
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
      load_revision_from_id(doc, req.query['since'] || "singularity", function(base_revision) {
        // Invalid ID.
        if (!base_revision) {
          res.status(400).send("Invalid base revision ID.")
          return;
        }

        // Fetch revisions since the base revision.
        var where = {
          documentId: doc.id,
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

            // Error parsng path.
            if (err) {
              res.status(400).send(err)
              return;
            }

            // Decode JSON and re-map to the API output format.
            revs = revs.map(function(rev) {
              rev.op = JSON.parse(rev.op);
              rev.userdata = JSON.parse(rev.userdata);
              return make_revision_response(rev, op_path);
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
}
