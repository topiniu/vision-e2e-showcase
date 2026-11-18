const { performance } = require('perf_hooks');

const timeOrigin = performance.timeOrigin;

const now = () => performance.now();
const epoch = () => timeOrigin + performance.now();

module.exports = {
  now,
  epoch,
  timeOrigin,
};
