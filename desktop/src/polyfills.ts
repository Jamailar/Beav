const objectConstructor = Object as ObjectConstructor & {
  hasOwn?: (object: unknown, property: PropertyKey) => boolean;
};

if (typeof objectConstructor.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true,
    writable: true,
    value(object: unknown, property: PropertyKey) {
      if (object === null || object === undefined) {
        throw new TypeError('Cannot convert undefined or null to object');
      }
      return Object.prototype.hasOwnProperty.call(Object(object), property);
    },
  });
}
