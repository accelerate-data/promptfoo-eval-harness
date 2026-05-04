module.exports = {
  ...require('./environment'),
  ...require('./eval-tier-config'),
  ...require('./package-discovery'),
  ...require('./paths'),
  ...require('./resolve-promptfoo-config'),
  roots: require('./roots'),
};
