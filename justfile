# Razor tooling fails on this stupid bug: https://github.com/dotnet/razor-tooling/issues/6241
workaround-razor-bug:
    export CLR_OPENSSL_VERSION_OVERRIDE=1.1; code .
