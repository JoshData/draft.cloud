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
  // Has the document changed locally since the last fetched content?
  var current_content = this.get_document();
  var patch = jot.diff(this.changes_last_content, current_content);
  if (!patch.isNoOp()) {
    // There's been a change. Record it.
    this.changes.push(patch);

    // And make the current state the new base.
    this.changes_last_content = current_content;
  }
}

exports.simple_widget.prototype.initialize = function(state) {
  this.logger = state.logger;
  this.logger(this.name + " initialized");

  // Start the base state off with the given document content.
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

exports.simple_widget.prototype.pop_changes = function(state) {
  // Return the local changes as a jot operation and clear the list.
  var patch = new jot.LIST(this.changes).simplify()
  this.changes = [];
  this.changes_start_content = this.changes_last_content;
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
  // changes_start_content + changes == document.
  this.compute_changes();
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
  this.compute_changes();
  if (this.changes.length > 0) {
    this.show_status("Not Saved");
  } else if (state == "saving") {
    this.show_status("Saving...");
  } else if (state == "saved") {
    this.show_status("Saved");
  }
}
