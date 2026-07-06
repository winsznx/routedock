// Testing utilities — a mock provider middleware for exercising settlement
// callbacks (onSettled / onSessionOpen / onVoucher) with synthetic data, no
// chain, no facilitator, no wallet. The `msw`-equivalent for RouteDock providers.
export * from './createMockRoutedockMiddleware.js'
