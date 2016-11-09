var bodyParser = require('body-parser')

var json_ptr = require('json-ptr');

var auth = require("./auth.js");
var models = require("./models.js");

var jot = require("../jot");

exports.create_routes = function(app) {
  // Set defaults for JSON responses.
  app.set("json spaces", 2);


  var document_route = '/api/v1/:owner/:document';

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
        // The user's access level if lower than the minimum access level required.
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

  function make_document_response(status_code, res, owner, doc) {
    res
    .status(status_code)
    .json({
      uuid: doc.uuid,
      name: doc.name,
      anon_access_level: doc.anon_access_level,
      owner: {
        uuid: owner.uuid,
        name: owner.name
      },
      userdata: doc.userdata
    })
  }

  app.put(document_route, bodyParser.json(), function (req, res) {
    // Create a document or update its metadata.
    //
    // See https://github.com/expressjs/body-parser#bodyparserjsonoptions for
    // default restrictions on the request body payload.
    //
    // Requires ADMIN permission on the document. (If the document doesn't yet
    // exist, we can still have ADMIN permission in virtue of being the same
    // user as the intended owner.)
    if (!req.body) return res.sendStatus(400);
    authz_document(req, res, false, "ADMIN", function(user, owner, doc) {
      if (!doc) {
        // Create document.
        models.Document.create({
          userId: owner.id,
          name: req.params.document,
          anon_access_level: req.body.anon_access_level,
          userdata: req.body.userdata || { }
        }).then(function(doc) {
          make_document_response(201, res, owner, doc);
        });
      } else {
        // Document exists. Update its metadata.
        doc.set("anon_access_level", req.body.anon_access_level || "");
        doc.set("userdata", req.body.userdata || { });
        doc.save().then(function() {
          make_document_response(200, res, owner, doc);
        })
      }
    })
  })

  app.get(document_route, function (req, res) {
    // Fetch metadata about a document.
    //
    // Requires READ permission on the document (and the document must exist).
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      make_document_response(200, res, owner, doc);
    })
  })

  app.delete(document_route, function (req, res) {
    // Delete a document.
    //
    // Requires WRITE permission on the document (or if the document doesn't exist yet,
    // then WRITE permission for the owner).
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
    if (at_revision == "singularity") {
      // This is a special flag that signals the state of the document
      // prior to the first Revision. The document is always a null value
      // at that state.
      cb(null, at_revision, null, []);
      return;
    }

    // Documents always start with a null value at the start of the revision history.
    var revision_id = "singularity";
    var content = null;

    // Find the most recent Revision with cached content, but no later
    // than the base_revision.
    models.Revision.findOne({
      where: {
        documentId: doc.id,
        id: { "$lte": at_revision ? at_revision.id : 9007199254740991 }, // ugh TODO replace this
        has_cached_document: true
      },
      order: [["id", "DESC"]]
    })
    .then(function(peg_revision) {
      // Load all subsequent revisions.
      models.Revision.findAll({
        where: {
          documentId: doc.id,
          id: {
            "$gt": peg_revision ? peg_revision.id : 0,
            "$lte": at_revision ? at_revision.id : 9007199254740991 // ugh TODO replace this
          }
        },
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
          var op = jot.opFromJsonableObject(JSON.parse(revs[i].op));
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
        // the change.
        if (pointer) {
          var op_path = [ ];
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
            if (typeof content == "undefined") {
              cb('Document path ' + pointer + ' not found.');
              return;
            }
          }
        }

        // Callback.
        cb(null, revision_id, content, op_path);
      });
    });
  }

  app.get(document_content_route, function (req, res) {
    // Fetch (the content of) a document. If a JSON Pointer is given at the end
    // of the path, then only return that part of the document. A JSON document
    // is returned. READ access is required.
    authz_document_content(req, res, "READ", function(user, owner, doc) {
      get_document_content(doc, req.params.pointer, null, function(err, revision_id, content) {
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

        if (format == "json")
          res.json(content);
        else if (format == "text")
          res.send(""+content);
        
      });
    })
  })

  function make_operation_from_new_content(pointer, old_content, new_content, cb) {
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
        return jot.opFromJsonableObject(JSON.parse(rev.op));
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
        op: op.toJsonableObject(),
        comment: comment,
        userdata: userdata
      }).then(function(rev) {
        res.status(201).json(make_revision_response(rev));
      });
    })
  }

  function make_revision_response(rev) {
    return {
      createdAt: rev.createdAt,
      uuid: rev.uuid,
      op: rev.op,
      author: rev.userId,
      comment: rev.comment,
      userdata: rev.userdata
    };
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

    if (!req._body) {
      // _body is set when bodyparser parses a body. If it's not truthy, then
      // we did not get a valid content-type header.
      res.status(400).send("Invalid PUT body content type.");
      return;
    }

    var userdata;
    if (req.headers['revision-userdata']) {
      try {
        userdata = JSON.parse(req.headers['revision-userdata']);
      } catch(e) {
        res.status(400).send("Invalid userdata: " + e);
        return;
      }
    }

    authz_document_content(req, res, "WRITE", function(user, owner, doc) {
      // Find the base revision. If not specified, it's the current revision.
      // If specified, we compute the changes from the base, then rebase them
      // against subsequent changes, and then commit that.
      function find_base_revision(cb) {
        // If "singularity" is passed, pass it through as a specicial revision.
        if (req.headers['base-revision-id'] == "singularity")
          cb("singularity")

        // Find the named revision.
        else if (req.headers['base-revision-id'])
          models.Revision.findOne({
            where: { documentId: doc.id, uuid: req.headers['base-revision-id'] },
          })
          .then(function(base_revision) {
            if (!base_revision)
              res.status(400).send("Invalid base revision ID.");
            else
              cb(base_revision);
          });

        // Get the most recent revision. If there are no revisions yet,
        // pass the spcial ID "singularity".
        else
          models.Revision.findOne({
            where: { documentId: doc.id },
            order: [["id", "DESC"]] // most recent
          })
          .then(function(base_revision) {
            if (!base_revision)
              cb("singularity");
            else
              cb(base_revision);
          });
      }
      find_base_revision(function(base_revision) {
        // Get the content of the document as of the base revision.
        get_document_content(doc, req.params.pointer, base_revision, function(err, revision_id, content, op_path) {
          if (err) {
            res.status(404).send(err);
            return;
          }

          make_operation_from_new_content(req.params.pointer, content, req.body, function(err, op) {
            if (err)
              res.status(400).send(err);
            else if (!op)
              // The document wasn't changed - don't take any action.
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

  app.patch(document_content_route, function (req, res) {
    // Apply changes to a document. The changes are given as JSON-serialized JOT
    // operations. If a JSON Pointer is given at the end of the path, the operations
    // are relative to that location in the document. WRITE access is required.
    authz_document_content(req, res, "WRITE", function(user, owner, doc) {
      res.send('apply patch ' + JSON.stringify(req.params))
    })
  })

  app.get(document_route + '/history', function (req, res) {
    // Gets the history of a document. The response is a list of changes.
    authz_document(req, res, true, "READ", function(user, owner, doc) {
      models.Revision.findAll({
        where: {
          documentId: doc.id
          //id: { "$gt": ? }
        },
        order: [["id", "DESC"]]
      })
      .then(function(revs) {
        res.json(revs.map(function(rev) {
          rev.op = JSON.parse(rev.op);
          rev.userdata = JSON.parse(rev.userdata);
          return make_revision_response(rev);
        }))
      })
    })
  })
}
