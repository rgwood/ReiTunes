#!/bin/bash
echo "Stopping service"
sudo systemctl stop reitunes
echo "Copying binaries"
sudo cp -r bin/Debug/net5.0/* /usr/local/bin/reitunes/
echo "Copying unit file"
sudo cp reitunes.service /etc/systemd/system/reitunes.service
echo "Enabling service"
sudo systemctl enable reitunes
echo "Starting service"
sudo systemctl start reitunes
