﻿using System;
using System.IO;
using System.Threading.Tasks;
using ReiTunes.Core;
using Windows.Storage;
using Windows.Storage.Streams;

namespace ReiTunes.Helpers;

// Use these extension methods to store and retrieve local and roaming app data
// More details regarding storing and retrieving app data at https://docs.microsoft.com/windows/uwp/app-settings/store-and-retrieve-app-data
public static class SettingsStorageExtensions
{
    private const string FileExtension = ".json";

    public static bool IsRoamingStorageAvailable(this ApplicationData appData)
    {
        return appData.RoamingStorageQuota == 0;
    }

    public static async Task SaveAsync<T>(this StorageFolder folder, string name, T content)
    {
        StorageFile file = await folder.CreateFileAsync(GetFileName(name), CreationCollisionOption.ReplaceExisting);
        string fileContent = await Json.SerializeAsync(content);

        await FileIO.WriteTextAsync(file, fileContent);
    }

    public static async Task<T> ReadAsync<T>(this StorageFolder folder, string name)
    {
        if (!File.Exists(Path.Combine(folder.Path, GetFileName(name))))
        {
            return default(T);
        }

        StorageFile file = await folder.GetFileAsync($"{name}.json");
        string fileContent = await FileIO.ReadTextAsync(file);

        return await Json.DeserializeAsync<T>(fileContent);
    }

    public static async Task SaveAsync<T>(this ApplicationDataContainer settings, string key, T value)
    {
        settings.SaveString(key, await Json.SerializeAsync(value));
    }

    public static void SaveString(this ApplicationDataContainer settings, string key, string value)
    {
        settings.Values[key] = value;
    }

    public static async Task<T> ReadAsync<T>(this ApplicationDataContainer settings, string key)
    {
        object obj = null;

        if (settings.Values.TryGetValue(key, out obj))
        {
            return await Json.DeserializeAsync<T>((string)obj);
        }

        return default(T);
    }

    public static async Task<StorageFile> SaveFileAsync(this StorageFolder folder, byte[] content, string fileName, CreationCollisionOption options = CreationCollisionOption.ReplaceExisting)
    {
        if (content == null)
        {
            throw new ArgumentNullException(nameof(content));
        }

        if (string.IsNullOrEmpty(fileName))
        {
            throw new ArgumentException("ExceptionSettingsStorageExtensionsFileNameIsNullOrEmpty".GetLocalized(), nameof(fileName));
        }

        StorageFile storageFile = await folder.CreateFileAsync(fileName, options);
        await FileIO.WriteBytesAsync(storageFile, content);
        return storageFile;
    }

    public static async Task<byte[]> ReadFileAsync(this StorageFolder folder, string fileName)
    {
        IStorageItem item = await folder.TryGetItemAsync(fileName).AsTask().ConfigureAwait(false);

        if ((item != null) && item.IsOfType(StorageItemTypes.File))
        {
            StorageFile storageFile = await folder.GetFileAsync(fileName);
            byte[] content = await storageFile.ReadBytesAsync();
            return content;
        }

        return null;
    }

    public static async Task<byte[]> ReadBytesAsync(this StorageFile file)
    {
        if (file != null)
        {
            using (IRandomAccessStream stream = await file.OpenReadAsync())
            {
                using (DataReader reader = new DataReader(stream.GetInputStreamAt(0)))
                {
                    await reader.LoadAsync((uint)stream.Size);
                    byte[] bytes = new byte[stream.Size];
                    reader.ReadBytes(bytes);
                    return bytes;
                }
            }
        }

        return null;
    }

    private static string GetFileName(string name)
    {
        return string.Concat(name, FileExtension);
    }
}
