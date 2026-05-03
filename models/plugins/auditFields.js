const mongoose = require('mongoose');

// Global Mongoose plugin — adds createdBy/updatedBy to every schema and
// auto-fills them from the per-request user context. Registered once in
// app.js BEFORE any model is required so it applies universally.
module.exports = function auditFields(schema) {
  schema.add({
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  });

  // Lazy require: this plugin is loaded BEFORE any model. Pulling
  // userContext.js at module top would force-load the User model too
  // early, before the plugin is registered. The require runs the first
  // time a hook fires, by which point everything is wired up.
  schema.pre('save', function (next) {
    const { getCurrentUser } = require('../../middleware/userContext.js');
    const user = getCurrentUser();
    if (user) {
      if (this.isNew) this.createdBy = user._id;
      this.updatedBy = user._id;
    }
    next();
  });

  schema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function (next) {
    const { getCurrentUser } = require('../../middleware/userContext.js');
    const user = getCurrentUser();
    if (user) {
      this.set({ updatedBy: user._id });
    }
    next();
  });
};
