const async = require("async");
const Sequelize = require('sequelize');
const models = require("./models.js");

const jot = require("jot");
const merge = require("jot/jot/merge.js");

exports.compute_merge_operation = function(target_doc, target_revision, source_doc, source_revision, callback) {
  // Compute a pair of JOT operations to merge changes in source_doc into target_doc
  // and vice versa.
  //
  // Typically source_doc is a fork of target_doc, or vice versa, but since
  // all documents have a common "singularity" revision ancestor, any two
  // documents can be merged.

  // To do a merge, we follow a procedure similar to git's "recursive" merge
  // strategy which needs a graph of the revision histories of the two documents
  // as far back as their lowest (i.e. nearest) common ancestors (there might
  // be multiple equally-near common ancestors).

  let revision_cache = { };
  let parent_map = { };

  function find_ancestors(doc, up_to_revision, cb) {
    if (doc.forkedFromId && !doc.forkedFrom)
      throw "Missing Sequelize include.";

    // Get all of the revisions in the document up to the
    // given revision.
    models.Revision.findAll({
      where: {
        documentId: doc.id,
        committed: true,
        id: { [Sequelize.Op.lte]: up_to_revision.id },
      },
      order: [["id", "ASC"]],
      include: models.Revision.INCLUDES
    }).then((revs) => {
      var parent_histories = { };

      // Map each revision ID to the ID of its parent.

      var prev_revision = "singularity";
      if (doc.forkedFrom) {
        prev_revision = doc.forkedFrom.id;
        parent_histories[doc.forkedFrom.id] = doc.forkedFrom;
      }

      revs.forEach((rev) => {
        revision_cache[rev.id] = rev;
        parent_map[rev.id] = [prev_revision];
        prev_revision = rev.id;

        if (rev.merges) {
          revision_cache[rev.merges.id] = rev.merges;
          parent_map[rev.id].push(rev.mergesId);
          parent_histories[rev.merges.id] = rev.merges;
        }
      })

      // If the document is a fork or if we encountered any merge revisions,
      // then also fetch those histories since there may be a relationship
      // between target_doc/source_doc and those parent documents. Unless we
      // already have its ancestors.
      var parent_history_ids = Object.keys(parent_histories).filter(id => !(id in parent_map));
      async.each(parent_history_ids, (id, cb) => {
        var d = parent_histories[id].document;
        if (!d.forkedFromId || d.forkedFrom)
          find_ancestors(d, parent_histories[id], cb)
        else // need to fetch from database to fill in forkedFrom data
          models.Document.findOne(
            { where: { id: d.id },
              include: models.Document.INCLUDES })
          .then(d1 => {
            find_ancestors(d1, parent_histories[id], cb)
          });
      }, (err) => {
        cb();
      })
    });
  }

  // Fetch the revision histories of the two documents.
  // TODO: Right now we're getting the entire revision history of both documents
  // back to the singularity initial revision common to all documents. This may
  // be severely inefficient. We don't need to go that far back. But it is hard
  // to know ahead of time how far back we need to go. Since we're going back
  // through the whole history, we only need to provide document content at the
  // singularity revision, since everything can be generated from that. But if
  // we pull less of a history, we'd need to get document content at other
  // revisions whose parents we aren't including.
  find_ancestors(target_doc, target_revision, () => {
    find_ancestors(source_doc, source_revision, () => {
      // Form a graph data structure for jot.merge.
      var graph = {
        singularity: { document: null }
      };
      Object.values(revision_cache).forEach(rev => {
        graph[rev.id] = {
          parents: parent_map[rev.id],
          op: [jot.opFromJSON(rev.op), rev.mergesOp ? jot.opFromJSON(rev.mergesOp) : null]
        };
      })


      try {
        var m = merge.merge(target_revision.id, source_revision.id, graph);
        callback(null, m[0], m[1]);
      } catch (e) {
        callback(e);
      }
    })
  })
}
