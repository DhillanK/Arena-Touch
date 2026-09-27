/* Arena Touch settings — edit on the show laptop, then reload the page on each tablet.
 *
 * Colour labels: Resolume's API only reports a colour NUMBER (1–6) for each clip, layer,
 * group and deck, not the actual colour. Set the hex colour each number should show as.
 * Use null for "no colour" (number 1 is Resolume's default / unlabelled).
 */
window.ARENA_TOUCH_CONFIG = {
  colours: {
    '1': null,
    '2': '#ff4d5e', // red
    '3': '#ffa53d', // orange
    '4': '#ffe14d', // yellow
    '5': '#3fd98a', // green
    '6': '#4d9fff', // blue
  },
};
