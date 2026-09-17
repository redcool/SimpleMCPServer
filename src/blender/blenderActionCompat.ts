/** Read all Action channels without creating slots/channelbags or using the legacy
 * first-slot-only facade on transitional Blender versions (4.4/4.5).
 * The optional slot restricts layered Actions; legacy Actions have no slots.
 */
export const BLENDER_ACTION_COMPAT = `def action_fcurves(action, slot=None):
    if action is None:
        return []
    layers = getattr(action, "layers", None)
    if layers is not None and (len(layers) or getattr(action, "is_action_layered", False)):
        curves = []
        seen = set()
        for layer in layers:
            for strip in layer.strips:
                bags = getattr(strip, "channelbags", None)
                if bags is None:
                    bags = []
                    if hasattr(strip, "channelbag"):
                        for action_slot in getattr(action, "slots", []):
                            bag = strip.channelbag(action_slot)
                            if bag is not None:
                                bags.append(bag)
                for bag in bags:
                    if slot is not None and bag.slot_handle != slot.handle:
                        continue
                    for curve in bag.fcurves:
                        key = curve.as_pointer() if hasattr(curve, "as_pointer") else id(curve)
                        if key not in seen:
                            seen.add(key)
                            curves.append(curve)
        return curves
    return list(getattr(action, "fcurves", []))
`;
