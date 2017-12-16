// simple_widget is the base class of widgets that detect local
// changes by polling at intervals and running diffs on a complete
// document.
//
// subclasses must implement:
// * show_message(level[str], message[str])
// * set_readonly(bool)
// * get_document() => any JSONable value
// * set_document(anything[, patch])
// * show_status(message[str])
//
// and may implement:
// * prepare_dom_async(callback)
//
// and for cursors:
// * get_cursor_char_range() => [index, length] or null
// * get_cursors_parent_element() => DOM element to place peer cursor divs
// * get_peer_cursor_rects(index, length) => [ { top: , left: , width: , height: }, ... ]
//
// and for other state:
// * get_ephemeral_state() => object
// * on_peer_state_updated(peerid, user, state)

var jot = require("jot");

var cursors = require('./cursors.js');

exports.simple_widget = function() {
  // Track local changes.
  this.changes_start_content = null;
  this.changes = [];
  this.changes_last_content = null;
}

exports.simple_widget.prototype.poll_interval = 1000;

exports.simple_widget.prototype.has_changes = function() {
  this.compute_changes();
  return this.changes.length > 0;
}

exports.simple_widget.prototype.compute_changes = function() {
  // This function is called at intervals to see if the widget's
  // content has changed. If the content has changed, a JOT operation
  // is constructed and stored in widget.changes.

  // Clear the subclass's flag that there are content changes
  // that have not yet been picked up by this function.
  this.clear_change_flag();

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

exports.simple_widget.prototype.get_change_flag = function() {
  return false;
}

exports.simple_widget.prototype.clear_change_flag = function() {
}

exports.simple_widget.prototype.initialize = function(logger, callback) {
  this.logger = logger;
  this.logger(this.name + " initializing");

  var _this = this;
  this.prepare_dom_async(function() {
    // If the widget supports showing peer cursors at character positions,
    // initialize a CursorManager.
    if (_this.get_cursors_parent_element && _this.get_peer_cursor_rects) {
      _this.cursors = new cursors.CursorManager({
        container: _this.get_cursors_parent_element(),
        rects: function(index, length) { return _this.get_peer_cursor_rects(index, length) },
      });
      if (_this.on_change_at_charpos) {
        _this.on_change_at_charpos(function(index, length, newlength) {
          _this.cursors.shift_cursors(index, length, newlength);
        });
      }
    }

    // Let the Client know the widget is ready.
    callback();
  });
}

exports.simple_widget.prototype.prepare_dom_async = function(callback) {
  callback();
}

exports.simple_widget.prototype.open = function(state) {
  // This method is called by the Client object when the document is opened.
  // Remember the user.
  this.user = state.user;

  // Start the base state off with the given document content.
  // (New documents begin as null, so we may immediately register
  // a change from null to the initial state of the widget, like
  // the empty string, if the widget's document cannot be null.)
  this.changes_start_content = state.content;
  this.changes_last_content = state.content;

  // Provide the content to the document.
  this.set_readonly(state.readonly);
  this.set_document(state.content);

  // Start polling for changes in the widget's contents, unless the
  // subclass does not require polling and calls compute_changes
  // itself.
  if (this.poll_interval > 0) {
    var _this = this;
    function poll_for_changes() {
      _this.compute_changes();
    }
    this.intervalId = setInterval(poll_for_changes, this.poll_interval);
  }

  // Initial peer states.
  Object.keys(state.peer_states).forEach(function(peerid) {
    _this.on_peer_state_updated(peerid, state.peer_states[peerid].user, state.peer_states[peerid].state);
  })

  // Show initial status.
  this.show_status("No Changes");
};

exports.simple_widget.prototype.document_closed = function() {
  // Stop polling.
  if (this.intervalId)
    clearInterval(this.intervalId);

  // Make the editor read only.
  this.set_readonly(true);
}

exports.simple_widget.prototype.pop_changes = function() {
  // This function is called by the Client instance that this widget
  // has been provided to. It returns a JOT operation for any changes
  // that have been made by the end user since the last call to
  // pop_changes and since any previous calls to merge_remote_changes.
  // It is called at frequent intervals to poll for changes in the
  // widget to be sent to the Draft.Cloud server.

  // Nothing new.
  if (this.changes.length == 0)
    return new jot.NO_OP();

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

exports.simple_widget.prototype.get_ephemeral_state = function() {
  var state = null;
  if (this.get_cursor_char_range) {
    var range = this.get_cursor_char_range();
    if (range)
      state = { cursor_charpos: { index: range[0], length: range[1] } };
  }
  return state;
}

exports.simple_widget.prototype.on_peer_state_updated = function(peerid, user, state) {
  if (this.cursors && user && state && state.cursor_charpos) {
    // Update cursor.
    this.cursors.update(peerid, {
      label: user.display_name || user.name || peerid,
      index: state.cursor_charpos.index,
      length: state.cursor_charpos.length
    });
  } else if (this.cursors) {
    // Peer disconnected.
    this.cursors.remove(peerid);
  }
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
  // remote changes have been applied. this.changes_start_content
  // was the state of the document before pending_changes ocurred
  // and, by contract with the Client class, also the state of the
  // documnet before patch ocurred.
  pending_changes = pending_changes.rebase(patch, { document: this.changes_start_content });
  this.changes_start_content = patch.apply(this.changes_start_content);
  if (pending_changes.isNoOp())
    this.changes = [];
  else
    this.changes = [pending_changes];
}

exports.simple_widget.prototype.status = function(state) {
  // state is "saving" or "saved"

  // If there was any error saving, it's permanent.
  if (state == "error")
    this.show_status("Could Not Save");

  // If there are any edits (checking synchronously), then the document is unsaved.
  else if (this.has_changes())
    this.show_status("Not Saved");

  // Or we could be saving changes that have been given
  // to the client class by pop_changes.
  else if (state == "saving")
    this.show_status("Saving...");

  // Or if the client class says everything is saved, and
  // nothing is pending, then everything is saved.
  else if (state == "saved")
    this.show_status("Saved");
}
