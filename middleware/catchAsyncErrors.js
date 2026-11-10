// Runs an async handler and hands whatever it throws to Express.
//
// The promise is returned so a unit test can `await` a handler and see
// what it did; Express itself ignores a middleware's return value.
module.exports = (theFunc) => (req, res, next) =>
  Promise.resolve(theFunc(req, res, next)).catch(next);
