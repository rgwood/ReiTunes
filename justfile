set shell := ["nu", "-c"]

watch:
    dotnet watch --project ReiTunes.Blazor/ReiTunes.Blazor.csproj

watch-tests:
    watch . { dotnet test } --glob=**/*.cs

publish:
    dotnet publish ReiTunes.Blazor/ReiTunes.Blazor.csproj \
    --runtime linux-arm64 \
    --output publish/ \
    --configuration Release --self-contained true -p:PublishSingleFile=true -p:DebugType=embedded -p:IncludeNativeLibrariesForSelfExtract=true

# upload: publish
#     rsync -r publish/ SERVER_NAME:services/PROJECT_NAME_new

# Razor tooling fails on this stupid bug: https://github.com/dotnet/razor-tooling/issues/6241
workaround-razor-bug:
    bash -c "export CLR_OPENSSL_VERSION_OVERRIDE=1.1; code ."
