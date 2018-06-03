// auto-resize the widget to the viewport height
function resize() { $('textarea#widget, div#widget').height($(window).height() - $('#widget').offset().top); }
resize();
$(window).resize(resize);

// log events
draft_cloud_on_event(function(doc, msg) {
var node = $("<div/>").text(msg);
$('#change_log').prepend(node);
})
