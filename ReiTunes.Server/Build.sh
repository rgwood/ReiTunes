#!/bin/bash
dotnet publish --configuration Release --runtime linux-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeAllContentForSelfExtract=true -p:DebugType=embedded --output publish/
