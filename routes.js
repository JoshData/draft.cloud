var bodyParser = require('body-parser')

var json_pointer = require('json-pointer');

var auth = require("./auth.js");
var models = require("./models.js");

var jot = require("./jot");

exports.create_routes = function(app) {
  // Set defaults for JSON responses.
  app.set("json spaces", 2);


  var document_route = '/api/v1/:owner/:document';

  // DOCUMENT CREATION/DELETION

  function authz_document(req, res, must_exist, needs_write, cb) {
    // Checks authorization for document URLs. The callback is called
    // as: cb(user, owner, document) where user is the user making the
    // request, owner is the owner of the document, and document is the
    // document.
    auth.get_document_authz(req, req.params.owner, req.params.document, function(user, owner, doc, perm) {
      // WRITE permission -> great!
      if (perm == "WRITE" && (!must_exist || doc))
        cb(user, owner, doc);

      // WRITE permission but the document doesn't exist
      else if (perm == "WRITE")
        res.status(404).send('Document not found.');

      // READ permission and only READ was needed -> great!
      else if (perm == "READ" && !needs_write && (!must_exist || doc))
        cb(user, owner, doc);

      // READ permission but either WRITE was needed or the document was needed
      // but it doesn't exist
      else if (perm == "READ" && !doc)
        res.status(404).send('Document not found.');
      else if (perm == "READ")
        res.status(403).send('You do not have permission to modify this document.');

      // does not even have READ, so we do not reveal whether or not the document exists
      else
        res.status(404).send('User or document not found or you do not have permission to see it.');
    })
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
    // Requires WRITE permission on the document (or if the document doesn't exist yet,
    // then WRITE permission for the owner).
    if (!req.body) return res.sendStatus(400);
    authz_document(req, res, false, true, function(user, owner, doc) {
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
    authz_document(req, res, true, false, function(user, owner, doc) {
      make_document_response(200, res, owner, doc);
    })
  })

  app.delete(document_route, function (req, res) {
    // Delete a document.
    //
    // Requires WRITE permission on the document (or if the document doesn't exist yet,
    // then WRITE permission for the owner).
    authz_document(req, res, true, true, function(user, owner, doc) {
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

  function authz_document_content(req, res, needs_write, cb) {
    // Checks authorization for document content URLs.
    authz_document(req, res, true, needs_write, function(user, owner, doc) {
      cb(user, owner, doc);
    })
  }

  var document_content_route = document_route + '/content:pointer(/[\\w\\W]*)?';

  function get_document_content(doc, pointer, at_revision, cb) {
    if (at_revision == "singularity") {
      // This is a special flag that signals the state of the document
      // prior to the first Revision. The document is always a null value
      // at that state.
      cb(null, at_revision, null);
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

        // Execute the JSON Pointer given in the URL.
        if (pointer) {
          try {
            content = json_pointer.get(result, pointer);
          } catch(e) {
            cb('Document path ' + pointer + ' not found.');
          }
        }

        // Callback.
        cb(null, revision_id, content);
      });
    });
  }

  app.get(document_content_route, function (req, res) {
    // Fetch (the content of) a document. If a JSON Pointer is given at the end
    // of the path, then only return that part of the document. A JSON document
    // is returned.
    authz_document_content(req, res, false, function(user, owner, doc) {
      get_document_content(doc, req.params.pointer, null, function(err, revision_id, content) {
        if (err)
          res.status(404).send(err);
        else {
          res.header("Revision-Id", revision_id)
          res.json(content);
        }
      });
    })
  })

  function make_operation_from_new_content(pointer, old_content, new_content, cb) {
    // Parse the pointer.
    if (pointer) {
      cb("pointer in PUT not implemented");
      return;
    }

    // Compute the JOT operation to transform the old content to the new content.
    var diff = require("./jot/diff.js");
    var op = diff.diff(old_content, new_content);

    // Don't make a revision if there was no change.
    var NO_OP = require('./jot/values.js').NO_OP;
    if (op instanceof NO_OP) {
      cb();
      return;
    }

    // Callback.
    cb(null, op);
  }

  function make_revision(user, doc, base_revision, op, comment, res) {
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
      var NO_OP = require('./jot/values.js').NO_OP;
      if (op instanceof NO_OP) {
        res.status(200).send("no change");
        return;
      }

      // Make a revision.
      models.Revision.create({
        userId: user.id,
        documentId: doc.id,
        op: op.toJsonableObject()
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
      author: rev.userId
    };
  }

  app.put(document_content_route, bodyParser.json(), function (req, res) {
    // Replace the document with new content. If a JSON Pointer is given at the end
    // of the path, then replace that part of the document only. The PUT body must
    // be JSON.
    authz_document_content(req, res, true, function(user, owner, doc) {
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
        get_document_content(doc, req.params.pointer, base_revision, function(err, revision_id, content) {
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
                req.headers['revision-comment'],
                res);
          })
        });

      });
    })
  })

  app.patch(document_content_route, function (req, res) {
    // Apply changes to a document. The changes are given as JSON-serialized JOT
    // operations. If a JSON Pointer is given at the end of the path, the operations
    // are relative to that location in the document.
    authz_document_content(req, res, true, function(user, owner, doc) {
      res.send('apply patch ' + JSON.stringify(req.params))
    })
  })

  app.get(document_route + '/history', function (req, res) {
    // Gets the history of a document. The response is a list of changes.
    authz_document(req, res, true, false, function(user, owner, doc) {
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
          return make_revision_response(rev);
        }))
      })
    })
  })
}
