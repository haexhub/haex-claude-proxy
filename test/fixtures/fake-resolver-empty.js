// Fixture used to exercise the dispatcher's "create() returned a bad shape"
// validation — has a create() export but the returned object is missing the
// required `name` / `resolve` fields.
export function create(_env) {
  return {};
}
