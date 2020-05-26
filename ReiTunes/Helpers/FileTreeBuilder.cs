using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text;

namespace ReiTunes.Helpers
{
	// Helper to build a tree of FileTreeItems from text
	public class FileTreeBuilder
    {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="blobList">A string where each line is a file path, separated with /</param>
        /// <returns></returns>
        public static ObservableCollection<FileTreeItem> ParseBlobList(string blobList)
        {
			// just creating this to hold results
			var root = new FileTreeItem("root","foo", FileTreeItemType.Folder);

			StringReader reader = new StringReader(blobList);
			string line;
			while ((line = reader.ReadLine()) != null)
			{
				IEnumerable<string> splitPath = line.Split('/');
				// I'd rather use SkipLast(1) but it's not available in .NET Standard 2
				var directories = new Queue<string>(splitPath.Take(splitPath.Count() - 1));
				var fileName = splitPath.Last();

				FileTreeItem currentDir = root;

				while (directories.Any())
				{
					var dirName = directories.Dequeue();

					var existingDirectory = currentDir.Children
						.Where(ei => ei.Name == dirName &&
									 ei.Type == FileTreeItemType.Folder)
									 .SingleOrDefault();

					if (existingDirectory != null)
					{
						currentDir = existingDirectory;
					}
					else
					{
						var newDir = new FileTreeItem(dirName, fullPath: line, FileTreeItemType.Folder);
						currentDir.Children.Add(newDir);
						currentDir = newDir;
					}
				}

				currentDir.Children.Add(new FileTreeItem(fileName, line));
			}
			return root.Children;
		}

		public static ObservableCollection<FileTreeItem> GetSampleData()
		{
			string rawBlobList = @"Avalanches/01 DJ Set - Brains Party @ St Jerome.mp3
Avalanches/02 BeatsInSpace-04.01.14 Part2 with.mp3
Avalanches/BBC R1 Essentials Mix 2016 - The Avalanches.mp3
Avalanches/Big Tent set 2006.mp3
Avalanches/Some People (Mixtape).mp3
Avalanches/The Avalanches - Mix Up 2001.mp3
Avalanches/The Avalanches GIMIX mixtape.mp3
Avalanches/The Avalanches on Radio 1 Breezebloc.mp3
Avalanches/The Avalanches- Beats in Space Mix.mp3
Between Villains (Earl Sweatshirt, Captain Murphy, MF DOOM).mp3
Bonobo - Essential Mix 2014 - BBC Radio 1.m4a
Daphni - 7.5 hr DJ Mix - Live from the Bussey Building. Oct 5, 2012. Part II.mp3
Jamie xx - BBC Radio 1 Essential Mix (2020-04-25).mp3
Kornel Kovacs - Mixmag Set - The Lab LDN.mp3
Max Cooper - Lockdown AV Session.mp3
Quantic Vinyl Set 2014 - Le Mellotro.m4a
Session Victim I 19.02.2016 I DJ Set.mp3
Solid Steel Radio Show 15_3_2013 Part 3 + 4 - DJ Scientist.mp3
The Avalanches & Jamie XX - B2B DJ Set on NTS Radio - 15.05.20.mp3
Tycho - Ingress - Burning Man Sunrise Set 2017.mp3
Tycho - Inversion - Burning Man Sunrise Set 2019.mp3";
			return ParseBlobList(rawBlobList);
		}
    }
}
