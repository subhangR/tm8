// Transplanted from maestro-ui/src/__tests__/setup.ts at snapshot b422978.
// It lived OUTSIDE src/collab-v2/, so the scoped `git archive` of the module
// did not carry it — a real gap in the transplant, not an optional extra.
//
// vitest 4: the "@testing-library/jest-dom/vitest" side-effect entry no-ops
// (matchers never register), so extend explicitly. Using the side-effect entry
// here fails ~70 assertions with "toBeInTheDocument is not a function", which
// reads as broken tests rather than as a missing setup file.
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

expect.extend(matchers);
