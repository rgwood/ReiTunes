﻿using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ReiTunes.Activation;
using ReiTunes.Core;
using ReiTunes.Helpers;
using ReiTunes.Logging;
using ReiTunes.Services;
using Serilog;
using System;
using System.Collections.Concurrent;
using System.Data.SQLite;
using System.IO;
using System.Net.Http;
using Windows.Storage;
using Windows.UI.ViewManagement;

namespace ReiTunes.Configuration {

    public class ServiceLocator : IDisposable {
        static private readonly ConcurrentDictionary<int, ServiceLocator> _serviceLocators = new ConcurrentDictionary<int, ServiceLocator>();

        static private ServiceProvider _rootServiceProvider = null;

        static public void Configure(IServiceCollection serviceCollection) {
            //TODO: add interfaces for some of these
            serviceCollection.AddSingleton<SuspendAndResumeService>();
            serviceCollection.AddSingleton<CommandLineActivationHandler>();
            serviceCollection.AddSingleton<HttpDataService>();

            serviceCollection.AddHttpClient(Options.DefaultName, (client) => { client.BaseAddress = new Uri(Secrets.ServerUrl); });

            serviceCollection.AddSingleton<HttpClient>((provider) => provider.GetService<IHttpClientFactory>().CreateClient());

            serviceCollection.AddSingleton<ILogger>((_) => LoggingFactory.BuildLogger());

            // Only ever have one player in the application
            serviceCollection.AddSingleton<PlayerViewModel>();

            serviceCollection.AddSingleton<ServerCaller>();

            //serviceCollection.AddSingleton((provider) => new ServerCaller(provider.GetService<IHttpClientFactory>().CreateClient()));

            var dbPath = Path.Combine(ApplicationData.Current.LocalFolder.Path, "library.db");

            serviceCollection.AddSingleton<SQLiteConnection>((_) => SQLiteHelpers.CreateFileDb(dbPath));

            serviceCollection.AddSingleton<Library>();

            //serviceCollection.AddSingleton((provider) => new Library(Environment.MachineName, SQLiteHelpers.CreateFileDb(dbPath),
            //    provider.GetService<ServerCaller>(), provider.GetService<ILogger>()));

            //serviceCollection.AddScoped<ICommonServices, CommonServices>();
            //serviceCollection.AddTransient<LoginViewModel>();

            _rootServiceProvider = serviceCollection.BuildServiceProvider();
        }

        static public ServiceLocator Current {
            get {
                int currentViewId = ApplicationView.GetForCurrentView().Id;
                return _serviceLocators.GetOrAdd(currentViewId, key => new ServiceLocator());
            }
        }

        static public void DisposeCurrent() {
            int currentViewId = ApplicationView.GetForCurrentView().Id;
            if (_serviceLocators.TryRemove(currentViewId, out ServiceLocator current)) {
                current.Dispose();
            }
        }

        private IServiceScope _serviceScope = null;

        private ServiceLocator() {
            _serviceScope = _rootServiceProvider.CreateScope();
        }

        public T GetService<T>() {
            return GetService<T>(true);
        }

        public T GetService<T>(bool isRequired) {
            if (isRequired) {
                return _serviceScope.ServiceProvider.GetRequiredService<T>();
            }
            return _serviceScope.ServiceProvider.GetService<T>();
        }

        #region Dispose

        public void Dispose() {
            Dispose(true);
            GC.SuppressFinalize(this);
        }

        protected virtual void Dispose(bool disposing) {
            if (disposing) {
                if (_serviceScope != null) {
                    _serviceScope.Dispose();
                }
            }
        }

        #endregion Dispose
    }
}