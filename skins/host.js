'use strict'

// dsh-skins — host half.
//
// The whole skin mechanism lives in the Web client: it composes a
// `--dsw-*` alias-token layer and hands it to the client `theme` service
// (ctx.theme.overrideTokens), which the ui-layout presenter writes onto
// document.body. Nothing needs to run on the host, but a plugin package still
// needs a Host entry to be loadable, so this half is intentionally inert.

module.exports = {
  inject: [],
  apply() {}
}
