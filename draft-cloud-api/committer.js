var async = require("async");

var routes = require("./routes.js");
var models = require("./models.js");

var jot = require("jot");

exports.begin = function() {
  setInterval(commit_uncommitted_revisions, 100);
}

exports.notify = function() {
  has_new_uncommitted_revisions = true;
}

var has_new_uncommitted_revisions = true;
var is_committing = false;

function commit_uncommitted_revisions() {
  // Don't go if there's another call to commit_uncommitted_revisions
  // in progress, or if there are no uncommitted revisions to process.
  if (is_committing || !has_new_uncommitted_revisions) return;
  is_committing = true;

  // Reset this flag. Set it to false early to avoid a race condition
  // that would lead to never knowing that a new change came in. Better
  // to err on the side of thinking there is a change when there is none.
  has_new_uncommitted_revisions = false;

  console.log("Committing...")

  // Pull all uncommitted revisions.
  models.Revision.findAll({
    where: {
      committed: false
    },
    order: [["documentId", "ASC"], ["id", "ASC"]]
  })
  .then(function(revs) {
    // Make a mapping from document IDs to arrays of revisions.
    var revsbydoc = { };
    revs.forEach(function(rev) {
      if (!(rev.documentId in revsbydoc))
        revsbydoc[rev.documentId] = [];
      revsbydoc[rev.documentId].push(rev);
    });

    // Fetch all Document instances.
    models.Document.findAll({
      where: {
        id: {
          $in: Object.keys(revsbydoc)
        }
      }
    })
    .then(function(docs) {
      // For each document...
      async.each(
        docs,
        function(doc, cb) {
          // Process all of the revisions in this document in order.
          var revs = revsbydoc[doc.id];
          async.eachSeries(
            revs,
            function(rev, cb) { commit_revision(doc, rev, cb); },
            function(err) {
              // Notify all listening websocket clients of the committed revisions
              // for this document.
              require("../draft-cloud-api/live.js").emit_revisions(doc, revs);
              cb();
              if (err) console.error(err);
            }
          );
        },
        function(err) {
          // All documents are done processing.
          // Unblock.
          is_committing = false;
        })
    });
  });
}

function commit_revision(document, revision, cb) {
  // Load the base revision.
  models.Revision.findOne({
    where: { documentId: document.id, id: revision.baseRevisionId },
  })
  .then(function(baseRevision) {
    if (baseRevision == null)
      baseRevision = "singularity";

    // Load the document at the base revision.
    routes.get_document_content(document, revision.doc_pointer, baseRevision, false /* don't cache */,
      function(err, doc_revision, content, op_path) {
        // There should not be any errors...
        if (err) {
          // There is an error with document content. It is too late to
          // do anything about this. But in order to prevent trying to
          // commit the revision over and over again, just kill it.
          revision.destroy(); // HMM!
          cb(err);
          return;
        }

        // Load the JOT operation.
        var op = jot.opFromJSON(revision.op);

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
            documentId: document.id,
            committed: true,
            id: {
              "$gt": revision.baseRevisionId == null ? 0 : revision.baseRevisionId,
            }
          },
          order: [["id", "ASC"]]
        })
        .then(function(revs) {
          // Load the JOT operations as a LIST.
          var base_ops = jot.LIST(revs.map(function(rev) {
            return jot.opFromJSON(rev.op);
          })).simplify();

          // Rebase. Pass the base document content to enable conflictless rebase.
          // TODO: This may throw.
          try {
            op = op.rebase(base_ops, { document: content });
          } catch (e) {
            // Rebase failed? That's bad.
            op = new jot.NO_OP();
          }

          // Make a revision.
          revision.op = op.toJSON();
          revision.baseRevisionId = null; // reset
          revision.doc_pointer = null; // reset
          revision.committed = true;
          revision.save().then(function() {
            console.log("committed", document.uuid, revision.uuid);
            cb();
          });
        }).catch(function(err) {
          revision.destroy(); // HMM!
          cb(err);
        });
    });
  });
}