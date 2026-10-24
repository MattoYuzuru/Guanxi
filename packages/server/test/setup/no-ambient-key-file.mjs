// Loaded into every server test process (`node --import`): the owner's own provider key file may be named in the shell that runs the
// suite, and no test may import it. Tests that need a key file name their own, through the `providerKeysFile` option or a command environment.
delete process.env.GUANXI_PROVIDER_KEYS_FILE
