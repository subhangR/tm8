/**
 * Mock layer barrel. Downstream layers consume ONLY: the facade instance
 * (createSeededFacade / MockFacade), SeedIds for demo deep-links, and the
 * Simulation driver. World internals stay private to mock/.
 */
export { MockFacade, createSeededFacade, type MockFacadeOptions } from './MockFacade';
export { createSeededWorld, type SeedIds, type SeededWorld } from './seed';
export { MockWorld } from './world';
export { Simulation, createSimulation, type SimulationOptions } from './simulation';
export { embedToken } from './internal';
