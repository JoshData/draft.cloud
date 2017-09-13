/* A generic class that draws cursors of other connected
   users. Each cursor has a label and a character range.
   */

// some nice colors to use for cursors
var cursor_colors = [ // copied from http://clrs.cc/
  "#001f3f", "#0074D9", "#39CCCC", "#3D9970", "#2ECC40",
  "#85144b", "#F012BE", "#B10DC9"
];

exports.CursorManager = function(options) {
  // Initialize.
  this.options = options;
  this.cursors = { };
}

exports.CursorManager.prototype.update = function(peerid, state) {
  // Create a new cursor?
  if (!(peerid in this.cursors)) {
    var cursor = { };
    this.cursors[peerid] = cursor;

    cursor.bar = document.createElement('div');
    this.options.container.appendChild(cursor.bar);
    cursor.bar.setAttribute('class', 'ddc-cursor-bar');
    cursor.bar.setAttribute('style', 'position: absolute; width: 0; height: 0; border-left: 2px solid black;');

    cursor.name = document.createElement('div');
    this.options.container.appendChild(cursor.name);
    cursor.name.setAttribute('class', 'ddc-cursor-name');
    cursor.name.setAttribute('style', 'position: absolute; cursor: default; overflow: hidden; max-width: 12em; '
                                    + 'border: 1px solid black; border-radius: .5em; padding: .125em; '
                                    + 'color: white; font-weight: bold; font-size: 90%; white-space: nowrap; text-overflow: ellipsis;');

    cursor.label = peerid;
    cursor.index = -1;
    cursor.length = 0;
  }

  // Update cursor state for any set fields.
  var cursor = this.cursors[peerid];
  if (typeof state.label != "undefined") cursor.label = state.label;
  if (typeof state.index != "undefined") cursor.index = state.index;
  if (typeof state.length != "undefined") cursor.length = state.length;

  // Update DOM.
  this.update_cursor_dom(peerid);
}

exports.CursorManager.prototype.shift_cursors = function(changes) {
  for (var peerid in this.cursors) {
    // Shift this cursor's position as needed.
    var cursor = this.cursors[peerid];
    changes.forEach(function(hunk) {
      var index = hunk[0];
      var length = hunk[1];
      var newlength = hunk[2];
      var dx = newlength-length;
      if (index+length <= cursor.index)
        cursor.index += dx; // occurs before
      else if (index < cursor.index && index+length < cursor.index+cursor.length)
        1; // overlaps start, not sure what to do
      else if (index < cursor.index)
        1; // entirely contains, not sure what to do
      else if (index >= cursor.index && index+length < cursor.index+cursor.length)
        cursor.length += dx; // entirely contained by
    });

    // Update DOM.
    this.update_cursor_dom(peerid);
  }
};

exports.CursorManager.prototype.remove = function(peerid) {
  // Remove the cursor for a peer.
  
  // Do we have a cursor for this peer?
  if (!(peerid in this.cursors))
    return;

  // Delete DOM elements and then remove from our state.
  var cursor = this.cursors[peerid];
  cursor.bar.parentNode.removeChild(cursor.bar);
  cursor.name.parentNode.removeChild(cursor.name);
  delete this.cursors[peerid];
}


exports.CursorManager.prototype.update_cursor_dom = function(peerid) {
  var cursor = this.cursors[peerid];

  // Update cursor bar & name DOM positions.
  var rects = this.options.rects(cursor.index, cursor.length);
  if (cursor.index == -1 || rects.length == 0) {
    // Cursor is not visible.
    cursor.bar.style.display = "none";
    cursor.name.style.display = "none";
    return;
  }
  cursor.bar.style.display = "block";
  cursor.name.style.display = "block";
  cursor.bar.style.top = rects[0].top + "px";
  cursor.bar.style.left = (rects[0].left-2) + "px";
  cursor.bar.style.height = rects[0].height + "px";
  cursor.name.style.top = (rects[0].top+rects[0].height) + "px";
  cursor.name.style.left = (rects[0].left-2) + "px";

  // Update DOM colors. Map the user's peerid stably to a color choice.
  // Since peerid's are random, we can use that as a numerical starting
  // point.
  var color_code = 0;
  for (var i = 0; i < peerid.length; i++) color_code += peerid.charCodeAt(i);
  var color = cursor_colors[color_code % cursor_colors.length];
  cursor.bar.style.borderColor = color;
  cursor.name.style.backgroundColor = color;
  cursor.name.style.borderColor = color;

  // Update name DOM.
  cursor.name.textContent = cursor.label;
}
