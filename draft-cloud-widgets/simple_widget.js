// simple_widget is the base class of widgets that detect local
// changes by polling at intervals and running diffs on a complete
// document.
//
// subclasses must implement:
// * nonfatal_error(message[str])
// * set_readonly(bool)
// * get_document([anything])
// * set_document(anything[, patch])
// * show_status(message[str])

var jot = require("../jot");

exports.poll_interval = 333;

exports.simple_widget = function() {
  // Track local changes.
  this.changes_start_content = null;
  this.changes = [];
  this.changes_last_content = null;
}

exports.simple_widget.prototype.compute_changes = function() {
  // This function is called at intervals to see if the widget's
  // content has changed. If the content has changed, a JOT operation
  // is constructed and stored in widget.changes.

  // Get the widget's current document content.
  var current_content = this.get_document();

  // Run a diff against the last time we did this.
  var op = jot.diff(this.changes_last_content, current_content);

  // If there hasn't been a change, return.
  if (op.isNoOp())
    return;

  // Record the change.
  this.changes.push(op);

  // Make the current content the new base for future diffs.
  this.changes_last_content = current_content;
}

exports.simple_widget.prototype.initialize = function(state) {
  this.logger = state.logger;
  this.logger(this.name + " initialized");

  // Start the base state off with the given document content.
  // (New documents begin as null, so we may immediately register
  // a change from null to the initial state of the widget, like
  // the empty string, if the widget's document cannot be null.)
  this.changes_start_content = state.content;
  this.changes_last_content = state.content;

  // Provide the content to the document.
  this.set_readonly(state.readonly);
  this.set_document(state.content);

  // Start polling for changes in the widget's contents.
  var _this = this;
  function poll_for_changes() {
    _this.compute_changes();
  }
  this.intervalId = setInterval(poll_for_changes, exports.poll_interval);
};

exports.simple_widget.prototype.destroy = function() {
  if (this.intervalId)
    clearInterval(this.intervalId);
}

exports.simple_widget.prototype.pop_changes = function() {
  // This function is called by the Client instance that this widget
  // has been provided to. It returns a JOT operation for any changes
  // that have been made by the end user since the last call to
  // pop_changes and since any previous calls to merge_remote_changes.
  // It is called at frequent intervals to poll for changes in the
  // widget.

  if (this.changes.length == 0) {
    // Nothing new.
    return new jot.NO_OP();
  }

  // Form a JOT operation.
  var op = new jot.LIST(this.changes).simplify()

  // Clear the changes queue.
  this.changes = [];

  // Track what the document held before the first element of changes
  // will have applied.
  this.changes_start_content = this.changes_last_content;

  // Return the operation.
  return op;
}

exports.simple_widget.prototype.merge_remote_changes = function(patch) {
  // This function is called by the Client instance that this widget
  // has been provided to whenever there are changes made by remote
  // users that need to be merged into the widget's state.
  //
  // patch is a JOT operation that comes in sequence after any changes
  // previously given to the Client by pop_changes.
  //
  // But the widget may already have been changed since the last time
  // the Client called pop_changes, so we have to rebase patch against
  // any changes the Client has not yet seen.
  //
  // Then we apply the patch to the widget's content and update the
  // widget.

  // Run compute_changes one last time synchronously so that
  // changes_start_content + changes gives us the actual
  // content present in the widget.
  this.compute_changes()
  var pending_changes = new jot.LIST(this.changes).simplify();

  // Bring the patch forward for any pending changes.
  var patch1 = patch.rebase(pending_changes, { document: this.changes_start_content });

  // Update the document.
  this.changes_last_content = patch1.apply(this.changes_last_content);
  this.set_document(this.changes_last_content, patch1);
  
  // Bring any pending changes forward so that when they are next
  // requested by the client, they take into account that the
  // remote changes have been applied.
  this.changes_start_content = patch.apply(this.changes_start_content);
  pending_changes = pending_changes.rebase(patch, { document: this.changes_start_content });
  if (pending_changes.isNoOp())
    this.changes = [];
  else
    this.changes = [pending_changes];
}

exports.simple_widget.prototype.status = function(state) {
  // state is "saving" or "saved"

  // Check synchronously for any new edits in the widget.
  this.compute_changes();

  // If there are any edits, then the document is unsaved.
  if (this.changes.length > 0) {
    this.show_status("Not Saved");

  // Or we could be saving changes that have been given
  // to the client class by pop_changes.
  } else if (state == "saving") {
    this.show_status("Saving...");

  // Or if the client class says everything is saved, and
  // nothing is pending, then everything is saved.
  } else if (state == "saved") {
    this.show_status("Saved");
  }
}
