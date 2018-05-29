var models = require("./models.js");

var ACCESS_LEVELS = ["NONE", "READ", "WRITE", "ADMIN"];

exports.DEFAULT_NEW_DOCUMENT_ANON_ACCESS_LEVEL = "NONE"; // i.e. no access

exports.is_access_level = function(level) {
  return typeof level == "string" && ACCESS_LEVELS.indexOf(level) >= 0;
}

exports.min_access = function(level1, level2) {
  if (ACCESS_LEVELS.indexOf(level1) < ACCESS_LEVELS.indexOf(level2))
    return level1;
  return level2;
}

function get_user_from_uuid(user_uuid, cb) {
  // Gets an User by name.
  models.User.findOne({
    where: {
      uuid: user_uuid,
    }
  })
  .then(function(user) {
    cb(user);
  });
}

function get_document_from_uuid(owner, document_uuid, cb) {
  // Gets a document given its owner (a User) and a document name.
  if (!document_uuid) {
    cb(null);
    return;
  }
  models.Document.findOne({
    where: {
      userId: owner.id,
      uuid: document_uuid
    }
  })
  .then(function(doc) {
    cb(doc);
  });
}

exports.check_request_authorization = function(req, cb) {
  cb(req.user, req.user_api_key);
}

exports.get_user_authz = function(req, user_uuid, cb) {
  // Gets the access level of the user to a user account.
  //
  // cb(requestor, target, level), where requestor is the User that is
  // making the request, target is the User whose resources are
  // being requested, and level is the access level the requestor has
  // on target.

  // Get the user that owns the document.
  get_user_from_uuid(user_uuid, function(target) {
    if (!target) {
      // the target does not exist, so nothing is possible
      cb();
      return;
    }

    // Get the user making the request.
    exports.check_request_authorization(req, function(requestor, requestor_api_key) {
      // Compute the access level in order of precedence.
      var level;

      // A User is an ADMIN to their own account.
      if (requestor && requestor.id == target.id)
        level = "ADMIN";

      // A User is an ADMIN to their sub-accounts.
      else if (requestor && requestor.id == target.ownerId)
        level = "ADMIN";

      else
        level = "NONE";

      // The API key may specify a lower access level either for particular
      // resources or for all resources.
      if (requestor_api_key) {
        if (typeof requestor_api_key.resource_acess_levels[target.uuid] != "undefined")
          // Limit to the access level for this particular resource.
          level = exports.min_access(level, requestor_api_key.resource_acess_levels[target.uuid]);
        else
          // Limit to the access level given in the key for all resources.
          level = exports.min_access(level, requestor_api_key.access_level);
      }

      cb(requestor, target, level);
    });

  });
}

exports.get_document_authz = function(req, owner_uuid, document_uuid, cb) {
  // Gets the access level of the user making a request to a document.
  //
  // cb(user, owner, document, level), where user is the User that is
  // making the request, owner is the User whose resources are
  // being requested, document is the resource being requested,
  // and level is the access level the user has for it.

  // Get the user that owns the document.
  get_user_from_uuid(owner_uuid, function(owner) {
    if (!owner) {
      // the owner does not exist, so nothing is possible
      cb();
      return;
    }

    // Get the document, if it exists. (It may not exist if the request is
    // to create a new document.)
    get_document_from_uuid(owner, document_uuid, function(document) {
      // Get the user making the request.
      exports.check_request_authorization(req, function(user, user_api_key) {
        // Get permissions for this user to this document.
        models.DocumentPermission.findOne({
          where: {
            documentId: document ? document.id : -1, // don't return anything if the document doesn't exist
            userId: user ? user.id : -1 // don't return anything if the user is anonymous
          }
        }).then(function(document_permission) {
          // Compute the access level in order of precedence.
          var level;

          // If the user owns this document, then the user has ADMIN level.
          // Ignore any explicit document permission.
          if (user && user.id == owner.id)
            level = "ADMIN";

          // If the document has granted access to the user, then use that.
          else if (document_permission)
            level = document_permission.access_level;

          // Otherwise the document, if it exists, provides a default access level
          // (but never more than WRITE (and if the requets is anonymous then not
          // more than READ).
          else if (document) {
            level = document.anon_access_level;

            // If the request is not authenticated, do not allow WRITE or ADMIN.
            if (!user)
              level = exports.min_access(level, "READ");

            // If the request is authenticated, still do not allow ADMIN as an
            // anonymous access level.
            else
              level = exports.min_access(level, "WRITE");
          
          } else {
            // Default to no level.
            level = "NONE";

          }

          // The API key may specify a lower access level either for particular
          // resources or for all resources.
          if (user_api_key) {
            if (document && typeof user_api_key.resource_acess_levels[document.uuid] != "undefined")
              // Limit to the access level for this particular resource.
              level = exports.min_access(level, user_api_key.resource_acess_levels[document.uuid]);
            else
              // Limit to the access level given in the key for all resources.
              level = exports.min_access(level, user_api_key.access_level);
          }

          cb(user, owner, document, level);
        });
      });

    });
  })
}
