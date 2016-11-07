var models = require("./models.js");

function get_owner(owner_name, cb) {
  // Gets an Owner by name.
  models.Owner.findOne({
    where: {
      name: owner_name,
    },
    paranoid: true // only return non-deleted rows
  })
  .then(function(owner) {
    cb(owner);
  });
}

function get_document(owner, document_name, cb) {
  // Gets a document by Owner and document name.
  models.Document.findOne({
    where: {
      ownerId: owner.id
    },
    paranoid: true // only return non-deleted rows
  })
  .then(function(doc) {
    if (doc)
      doc.meta = JSON.parse(doc.meta);
    cb(doc);
  });

}

exports.get_owner_authz = function(req, owner, cb) {
  // Is the user making the request authorized to read or write
  // things for this owner? The callback is called as:
  // cb(user, owner, permissions), where user is the Owner that is
  // making the request and owner is the Owner whose resources are
  // being requested.
  get_owner(owner, function(owner) {
    if (!owner) {
      // the owner does not exist, so there cannot be any permissions
      cb(null, null, "");
      return;
    }

    // Check if the request includes an API key that gives further access.
    models.OwnerApiKey.findOne({
      where: {
        ownerId: owner.id,
        key: req.headers['authorization']
      }})
    .then(function(api_key) {
      if (api_key)
        cb(owner, owner, api_key.access_level);
      else
        cb(null, owner, "");
    });

  });
}

exports.get_document_authz = function(req, owner_name, document_name, cb) {
  // Is the user making the request authorized to READ or WRITE
  // to this document? The callback is called as:
  // cb(user, owner, document, permissions), where user is the Owner that is
  // making the request, owner is the Owner whose resources are
  // being requested, document is the resource being requested,
  // and permissions are the access level the user has for it.
  exports.get_owner_authz(req, owner_name, function(user, owner, owner_perms) {
    if (!owner) {
      // the owner does not exist, so neither does the document
      cb(user, null, null, "");
      return;
    }

    get_document(owner, document_name, function(document) {
      // If a user has WRITE permission to the owner, then they have
      // write permission to the document.
      //
      // If the document does not exist, then the permissions fall back
      // to owner-level permissions.
      if (owner_perms == "WRITE" || !document)
        cb(user, owner, document, owner_perms);

      // If the document grants public READ or WRITE access, then that goes.
      else if (document.default_access_level != "")
        cb(user, owner, document, document.default_access_level);

      // The document doesn't give public access, so fall back to whether
      // the user has READ access via the owner.
      else
        cb(user, owner, document, owner_perms);

    });
  })
}
