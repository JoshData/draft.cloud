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
  // Track the base content to see when changes are made.
  this.base_content = null;

  // Track local changes.
  this.changes = [];
}

exports.simple_widget.prototype.compute_changes = function() {
  // Has the document changed locally since the last fetched content?
  var current_content = this.get_document(this.base_content);
  var patch = jot.diff(this.base_content, current_content);
  if (!patch.isNoOp()) {
    // There's been a change. Record it.
    this.changes.push(patch);

    // And make the current state the new base.
    this.base_content = current_content;
  }
}

exports.simple_widget.prototype.initialize = function(state) {
  // Start the base state off with the given document content.
  this.base_content = state.content;

  // Provide the content to the document.
  this.set_readonly(state.readonly);
  this.set_document(state.content);

  // The polling function that checks for changes in the widget's contents.
  var _this = this;
  function poll_for_changes() {
    _this.compute_changes();
    setTimeout(poll_for_changes, exports.poll_interval);
  }

  // Start polling for changes.
  poll_for_changes();
};

exports.simple_widget.prototype.pop_changes = function(state) {
  // Return the local changes as a jot operation and clear the list.
  var patch = new jot.LIST(this.changes).simplify()
  this.changes = [];
  return patch;
}

exports.simple_widget.prototype.merge_remote_changes = function(patch) {
  // We've got remote changes to merge into the widget's document.
  // We have two tasks:
  //
  // * The patch is against the state of the document the last time
  //   pop_changes was called. We may have pending recorded changes
  //   in local_changes that we have to rebase.
  //
  // * The widget itself must be updated.

  // Run compute_changes one last time so that
  // base_content + changes == document.
  this.compute_changes();

  // Bring any pending changes forward.
  var pending_changes = new jot.LIST(this.changes).simplify();
  this.changes = [pending_changes.rebase(patch, true)];
  if (this.changes[0].isNoOp()) this.changes = [];

  // Bring the patch forward for any pending changes.
  patch = patch.rebase(pending_changes, true);

  // Update the document.
  var new_content = patch.apply(this.base_content);
  this.set_document(new_content, patch);
  this.base_content = new_content;
}

exports.simple_widget.prototype.status = function(state) {
  // state is "saving" or "saved"
  this.compute_changes();
  if (this.changes.length > 0) {
    this.show_status("Not Saved");
  } else if (state == "saving") {
    this.show_status("Saving...");
  } else if (state == "saved") {
    this.show_status("Saved");
  }
}
