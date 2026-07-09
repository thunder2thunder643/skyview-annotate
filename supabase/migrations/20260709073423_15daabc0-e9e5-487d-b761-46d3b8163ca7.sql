
CREATE POLICY "Users read own satellite files" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'satellite-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users upload own satellite files" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'satellite-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users update own satellite files" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'satellite-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users delete own satellite files" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'satellite-images' AND auth.uid()::text = (storage.foldername(name))[1]);
