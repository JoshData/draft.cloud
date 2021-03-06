var async = require("async");
const Sequelize = require('sequelize');
const Queue = require('queue');

var models = require("./models.js");

var jot = require("jot");

// Revisions must be committed serially for each document, but
// can be committed out of order across documents. Create a Queue
// for each document, with each Queue permitting no concurrency.
var document_queues = { };
var sync_queue = [];

exports.save_revision = function(revision_data, cb) {
  // Schedule an asynchronous commit of the revision and call the
  // callback once it is committed.
  var rev = models.Revision.build({
    userId: revision_data.user.id,
    documentId: revision_data.doc.id,
    baseRevisionId: revision_data.base_revision == "singularity" ? null : revision_data.base_revision.id,
    doc_pointer: revision_data.pointer,
    op: revision_data.op.toJSON(),
    userdata: revision_data.userdata,
    mergesId: revision_data.merges_revision ? revision_data.merges_revision.id : null,
    mergesOp: revision_data.merges_revision ? revision_data.merges_op.toJSON() : null
  })
  rev.user = revision_data.user; // fill in model with instance - expected by cb
  rev.document = revision_data.doc; // fill in model with instance - expected by commit_revision
  rev.baseRevision = revision_data.base_revision; // fill in model with instance - expected by commit_revision
  rev.merges = revision_data.merges_revision; // fill in model with instance
  
  // Queue revision.
  queue_revision(rev, function(err) {
    cb(err, rev);
  });
}

function queue_revision(rev, on_committed) {
  // rev is a models.Revision.

  // Get or create the Queue for this document.
  var queue;
  if (rev.documentId in document_queues)
    queue = document_queues[rev.documentId];
  else
    queue = document_queues[rev.documentId] = new Queue({
      concurrency: 1,
      autostart: true
    })

  // Add revision to queue.
  queue.push(function(cb) {
    // Commit this revision.
    commit_revision(rev, function(err) {
      on_committed(); // caller wants to know when revision is committed to the database
      cb(); // queue wants to know when this job is done

      // If this was the last one in the queue, delete the queue.
      if (queue.length == 0) {
        delete document_queues[rev.documentId];

        // If this was the last queue, call the sync callbacks.
        if (document_queues.length == 0) {
          sync_queue.forEach((item) => item());
          sync_queue = [];
        }
      }
    });
  });
}

exports.sync = function(cb) {
  // Wait for all pending revisions to be committed --- useful for
  // graceful shutdowns and tests.
  if (document_queues.length == 0)
    cb();
  else
    sync_queue.push(cb);
}

function commit_revision(revision, cb) {
    function error_handler(err) {
      console.error("unhandled error committing", revision.document.uuid, revision.uuid, err);
      revision.error = true;
      if (!revision.isNewRecord) // already in database? update it.
        revision.save();
      cb(err);
    }

    // Load the document at the base revision.
    revision.document.get_content(null, revision.baseRevision, false /* don't cache */,
      function(err, doc_revision, content, __) {
        // There should not be any errors...
        if (err) {
          // There is an error with document content.
          error_handler(err);
          return;
        }

        // Load the JOT operation.
        var op = jot.opFromJSON(revision.op);

        // If this operation occurred at a sub-path on the document, then wrap the
        // operation within APPLY operations to get down to that path. doc_pointer
        // doesn't distinguish between array indexes and object keys, so use
        // parse_json_pointer_path_with_content to figure that out. After this,
        // op and content are both relative to the whole document. It would be nice
        // if we could focus just on the targeted path, but because we might rebase
        // on operations that affected other parts of the document that might also
        // affect the targeted part, it's probably safer to work on the whole document.
        var parsed_path = models.parse_json_pointer_path_with_content(revision.doc_pointer, content);
        for (var i = parsed_path[0].length-1; i >= 0; i--)
          op = new jot.APPLY(parsed_path[0][i], op);

        // Validate the operation. It should apply without error to the document
        // at the base revision.
        try {
          op.apply(content);
        } catch (e) {
          error_handler(e);
          return;
        }

        // Rebase against all of the subsequent operations after the base revision to
        // the current revision. Find all of the subsequent operations.
        models.Revision.findAll({
          where: {
            documentId: revision.document.id,
            committed: true,
            id: {
              [Sequelize.Op.gt]: revision.baseRevisionId == null ? 0 : revision.baseRevisionId,
            }
          },
          order: [["id", "ASC"]]
        })
        .then(function(revs) {
          // Load the JOT operations as a LIST.
          var base_ops = new jot.LIST(revs.map(function(rev) {
            return jot.opFromJSON(rev.op);
          })).simplify();

          // Rebase. Pass the base document content to enable conflictless rebase.
          try {
            // Rebase.
            op = op.rebase(base_ops, { document: content });
          } catch (e) {
            error_handler(e);
            return;
          }

          // Ensure operation is simplified.
          op = op.simplify();

          try {
            // Although rebase should always give us a good result, sanity check
            // that a) the operation can be composed with the prior operations and
            // b) it can apply to the current document content. We sanity check
            // two ways to be sure we don't corrupt the document. We're just
            // checking for thrown exceptions. A deep-equal comparison might also
            // be good.
            //
            // Save the final content so we can cache the new document content.
            var new_content = op.apply(base_ops.apply(content)); // (content + base_ops) + op
            base_ops.compose(op).apply(content); // content + (base_ops+op)
            content = new_content;
          } catch (e) {
            // Don't commit it.
            error_handler(e);
            return;
          }

          // Make a revision.
          revision.op = op.toJSON();
          revision.baseRevisionId = null; // reset
          revision.doc_pointer = null; // reset
          revision.committed = true;
          revision.save().then(function(saved_rev) {
            // Log.
            console.log("committed", revision.document.uuid, revision.uuid);

            // Indicate this revision is finished.
            debugging_paused_callback(cb);

            // Save to cache.
            models.volatile_cache.set("revision_" + saved_rev.uuid, saved_rev);
            models.volatile_cache.set("cachedcontent_latest_" + revision.document.id, {
              document_content: content,
              revision: saved_rev
            });
          }).catch(error_handler);
        }).catch(error_handler);
    });
}

function debugging_paused_callback(cb) {
  if (!process.env.SLOW_COMMITTER)
    cb();
  else
    setTimeout(cb, parseFloat(process.env.SLOW_COMMITTER));
}
