/**
 * DEPRECATED shim: the `design` kind is `craft` since migration 315. These
 * old names re-export ./craft so src/craft keeps compiling while L4 moves it
 * over; import from './craft' in new code. Delete once nothing imports it.
 */
export {
  CRAFT_KIND as DESIGN_KIND,
  craftContentOf as designContentOf,
  craftStateOf as designStateOf,
  type CraftContent as DesignContent,
  type CraftContentRead as DesignContentRead,
  type CraftKind as DesignKind,
  type CraftPage as DesignPage,
  type CraftState as DesignState,
} from './craft';
