﻿using System;
using System.Collections.Concurrent;
using Windows.UI.ViewManagement;
using Microsoft.Extensions.DependencyInjection;
using ReiTunes.Services;
using ReiTunes.Activation;
using Serilog;
using ReiTunes.Helpers;
using System.IO;
using Windows.System;
using System.Threading.Tasks;

namespace ReiTunes.Configuration
{
    public class ServiceLocator : IDisposable
    {
        static private readonly ConcurrentDictionary<int, ServiceLocator> _serviceLocators = new ConcurrentDictionary<int, ServiceLocator>();

        static private ServiceProvider _rootServiceProvider = null;

        static public async Task Configure(IServiceCollection serviceCollection)
        {
            //TODO: add interfaces for some of these
            serviceCollection.AddSingleton<SuspendAndResumeService>();
            serviceCollection.AddSingleton<CommandLineActivationHandler>();
            serviceCollection.AddSingleton<HttpDataService>();

            serviceCollection.AddSingleton<ILogger>((_) => BuildLogger());

            // Only ever have one player in the application
            serviceCollection.AddSingleton<PlayerViewModel>();

            //serviceCollection.AddScoped<ICommonServices, CommonServices>(); 
            //serviceCollection.AddTransient<LoginViewModel>();

            _rootServiceProvider = serviceCollection.BuildServiceProvider();
        }

        static private ILogger BuildLogger()
        {
            var cache = Windows.Storage.ApplicationData.Current.LocalCacheFolder;
            var logFile = Path.Combine(cache.Path, "ReiTunes.txt");

            return new LoggerConfiguration()
                      .WriteTo.File(logFile, rollingInterval: RollingInterval.Day)
                      .CreateLogger();
        }

        static public ServiceLocator Current
        {
            get
            {
                int currentViewId = ApplicationView.GetForCurrentView().Id;
                return _serviceLocators.GetOrAdd(currentViewId, key => new ServiceLocator());
            }
        }

        static public void DisposeCurrent()
        {
            int currentViewId = ApplicationView.GetForCurrentView().Id;
            if (_serviceLocators.TryRemove(currentViewId, out ServiceLocator current))
            {
                current.Dispose();
            }
        }

        private IServiceScope _serviceScope = null;

        private ServiceLocator()
        {
            _serviceScope = _rootServiceProvider.CreateScope();
        }

        public T GetService<T>()
        {
            return GetService<T>(true);
        }

        public T GetService<T>(bool isRequired)
        {
            if (isRequired)
            {
                return _serviceScope.ServiceProvider.GetRequiredService<T>();
            }
            return _serviceScope.ServiceProvider.GetService<T>();
        }

        #region Dispose
        public void Dispose()
        {
            Dispose(true);
            GC.SuppressFinalize(this);
        }

        protected virtual void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_serviceScope != null)
                {
                    _serviceScope.Dispose();
                }
            }
        }
        #endregion
    }
}