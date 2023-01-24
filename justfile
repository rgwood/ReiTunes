set shell := ["nu", "-c"]

watch:
    dotnet watch --project ReiTunes.Blazor/ReiTunes.Blazor.csproj

run:
    dotnet run --project ReiTunes.Blazor/ReiTunes.Blazor.csproj

build:
    dotnet build --project ReiTunes.Blazor/ReiTunes.Blazor.csproj --configuration Release

watch-tests:
    watch . { dotnet test } --glob=**/*.cs

publish:
    dotnet publish ReiTunes.Blazor/ReiTunes.Blazor.csproj \
    --runtime linux-arm64 \
    --output publish/ \
    --configuration Release --self-contained true -p:PublishSingleFile=true -p:DebugType=embedded -p:IncludeNativeLibrariesForSelfExtract=true

# upload: publish
#     rsync -r publish/ SERVER_NAME:services/PROJECT_NAME_new
