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

    // Set metadata.

    cursor.label = peerid;
    cursor.index = -1;
    cursor.length = 0;

    // Create DOM elements.

    cursor.bar = document.createElement('div');
    this.options.container.appendChild(cursor.bar);
    cursor.bar.setAttribute('class', 'ddc-cursor-bar');
    cursor.bar.setAttribute('style', 'position: absolute; width: 0; height: 0; border-left: 2px solid black;');

    cursor.name = document.createElement('div');
    this.options.container.appendChild(cursor.name);
    cursor.name.setAttribute('class', 'ddc-cursor-name');
    cursor.name.setAttribute('style', 'position: absolute; cursor: default; overflow: hidden; max-width: 12em; '
                                    + 'border: 1px solid black; border-radius: .5em; padding: .25em; '
                                    + 'color: white; font-weight: bold; font-size: 90%; line-height: 105%; white-space: nowrap; text-overflow: ellipsis;');

    // Attach hover event. When the mouse moves over the cursor, pop
    // it to an alternate location, until the user mouseovers it again,
    // and then pop it back.
    var _this = this;
    cursor.name.addEventListener("mouseover", function() {
      cursor.mouseover = !cursor.mouseover;
      _this.update_cursor_dom(peerid);
    })
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

  // Get cursor location.
  var rects = this.options.rects(cursor.index, cursor.length);
  if (cursor.index == -1 || rects.length == 0) {
    // Cursor is not visible.
    cursor.bar.style.display = "none";
    cursor.name.style.display = "none";
    return;
  }

  // Update name DOM -- affects height.
  cursor.name.textContent = cursor.label;

  // Update cursor bar & name DOM positions.
  cursor.bar.style.display = "block";
  cursor.name.style.display = "block";
  cursor.bar.style.top = (rects[0].top-1) + "px";
  cursor.bar.style.left = (rects[0].left-2) + "px";
  cursor.bar.style.height = (rects[0].height+2) + "px";
  if (!cursor.mouseover) {
    // show cursor below text
    cursor.name.style.top = (rects[0].top+rects[0].height+1) + "px";
    cursor.name.style.borderRadius = "0 .5em .5em .5em";
  } else {
    // show cursor above text
    cursor.name.style.top = (rects[0].top-cursor.name.offsetHeight-1) + "px";
    cursor.name.style.borderRadius = ".5em .5em .5em 0";
  }
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
}

